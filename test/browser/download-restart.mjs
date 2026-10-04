import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../../app/core/store/schema.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const db = new DatabaseSync(':memory:'); db.exec(SCHEMA);
const root = fileURLToPath(new URL('../../app/', import.meta.url));
const fixture = await readFile(new URL('../fixtures/work-page.html', import.meta.url), 'utf8');
const requests = [], errors = [], external = [], ready = [], diagnostics = [];
let exportRequests = 0, nativeSerial = 0;
const nativeResponses = new Map();
const setQueue = (state, source = null) => {
  db.exec('DELETE FROM chapters; DELETE FROM works; DELETE FROM meta;');
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('queue', JSON.stringify([
    {author:'Synthetic author',part:'works',state,workIds:['1','2'],total:2,open:Boolean(source),source,historyComplete:true},
  ]));
};
const saved = () => JSON.parse(db.prepare("SELECT value FROM meta WHERE key='queue'").get().value);
const server = createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost');
  const json = value => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === '/bridge') {
      let body=''; for await (const chunk of req) body+=chunk;
      const {method,args}=JSON.parse(body);
      if (method==='startArchiveRequest') {
        const target=new URL(args[0]);
        assert.equal(target.origin,'https://archiveofourown.org');
        assert.match(target.pathname,/^\/works\/[12]$/);
        requests.push(target.pathname);
        nativeResponses.set(++nativeSerial,{status:200,body:fixture});
        return json(nativeSerial);
      }
      if (method==='takeArchiveResponse') {
        const result=nativeResponses.get(args[0]); nativeResponses.delete(args[0]);
        return json(result);
      }
      if (method==='query') return json({rows:db.prepare(args[0]).all(...JSON.parse(args[1]))});
      if (method==='saveMeta') db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(...args);
      if (method==='downloadsReady') ready.push(args[0]);
      if (method==='downloadDiagnostic') diagnostics.push({event:args[0],data:JSON.parse(args[1])});
      if (method==='exportDownloadDiagnostics') exportRequests++;
      if (method==='saveWork') {
        const work=JSON.parse(args[0]);
        db.prepare('INSERT OR REPLACE INTO works(work_id,title,authors,chapter_count,has_text,complete) VALUES(?,?,?, ?,1,1)')
          .run(work.workId,work.title,work.authors,work.chapters.length);
        for (const [i,ch] of work.chapters.entries()) db.prepare('INSERT OR REPLACE INTO chapters(work_id,number,html,text) VALUES(?,?,?,?)')
          .run(work.workId,i+1,ch.html,ch.text);
      }
      return json({ok:true});
    }
    if (url.pathname==='/__net/') {
      const target=new URL(url.searchParams.get('url'));
      assert.match(target.pathname,/^\/works\/[12]$/);
      requests.push(target.pathname); res.setHeader('Content-Type','text/html'); return res.end(fixture);
    }
    if (url.pathname==='/__images/next') return json({done:true});
    if (url.pathname==='/version.txt') return res.end('download-restart-test');
    const path=resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if (!path.startsWith(root)) { res.writeHead(403); return res.end(); }
    res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(path)]||'application/octet-stream');
    res.end(await readFile(path));
  } catch(error) { errors.push(error.message); res.writeHead(500);res.end('Fixture failure'); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
const context=await browser.newContext();
let page;
async function open(command='',cooldown=0,nativeTransport=false) {
  ready.length=0;
  page=await context.newPage();
  await page.addInitScript(({command,cooldown,nativeTransport})=>{
    window.testTime=Date.parse('2026-10-03T12:00:00Z');
    Date.now=()=>window.testTime;
    Math.random=()=>0;
    if(nativeTransport) localStorage.removeItem('archive.pacing');
    if(cooldown) localStorage.setItem('archive.pacing',JSON.stringify({coolUntil:Date.now()+cooldown,lastArchiveAt:0}));
    const bridge=method=>(...args)=>{const req=new XMLHttpRequest();req.open('POST','/bridge',false);req.send(JSON.stringify({method,args}));return req.responseText;};
    window.ArchiveNative=new Proxy({
      status:()=>JSON.stringify({hasDatabase:true,search:true,nativeArchiveRequests:nativeTransport}),signedIn:()=>true,
      takePendingOpen:()=>'',takePendingLink:()=>'',databaseSize:()=>1,
      takeDownloadCommand:()=>command,
      ...Object.fromEntries(['query','saveMeta','saveWork','downloadsReady','downloadDiagnostic','exportDownloadDiagnostics','startArchiveRequest','takeArchiveResponse'].map(method=>[method,bridge(method)])),
    },{get:(target,key)=>target[key]||(()=>'{}')});
    if(nativeTransport) {
      const ordinaryFetch=window.fetch;
      window.fetch=(input,...args)=>{
        if(String(input).includes('/__net/')) throw new Error('Browser archive request dispatch is suspended');
        return ordinaryFetch(input,...args);
      };
    }
  },{command,cooldown,nativeTransport});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(origin);
  await page.waitForFunction(()=>typeof window.__downloadsPending==='function');
  assert.equal(ready.length,1,'runtime gets a readiness response after restoration');
}
async function tick(ms) {
  await page.evaluate(ms=>{window.testTime+=ms;window.__tick();},ms);
  // Let network and synchronous bridge callbacks settle without changing pacing.
  for(let n=0;n<8;n++) await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
}
try {
  for(const source of [null,{kind:'author',author:'Synthetic author',part:'works'},{kind:'bookmarks-new'},{kind:'bookmarks-all'},{kind:'history',user:'reader'}]) {
  for(const command of ['__pauseAll','__stopAll']) {
    setQueue('running',source);await open(command);await tick(600000);
    assert.deepEqual(requests,[],`${command} on cold start must issue no request`);
    assert.equal(saved()[0].state,command==='__pauseAll'?'paused':'cancelled');
    assert.equal(ready.at(-1),command==='__pauseAll');
    await page.close();
  }
  }
  setQueue('paused');await open();await tick(600000);
  assert.equal(saved()[0].state,'paused');assert.deepEqual(requests,[],'saved pause survives restart');await page.close();

  setQueue('running');await open('',300000);await tick(299999);
  assert.deepEqual(requests,[],'restored cooldown is honoured');
  await tick(1);
  await page.waitForFunction(()=>document.querySelector('#activity-dot').dataset.state==='busy');
  await page.waitForFunction(()=>JSON.parse(window.ArchiveNative.query("SELECT value FROM meta WHERE key='queue'",'[]')).rows.some(row=>JSON.parse(row.value)[0].added===1));
  assert.deepEqual(requests,['/works/1']);
  assert.equal(saved()[0].added,1,JSON.stringify({errors,queue:saved()}));
  assert.deepEqual(saved()[0].workIds,['2']);
  await page.close(); // A killed page must recover from persisted state, not repeat work 1.
  await open();await tick(600000);
  await page.waitForFunction(()=>JSON.parse(window.ArchiveNative.query("SELECT value FROM meta WHERE key='queue'",'[]')).rows.some(row=>JSON.parse(row.value)[0].added===2));
  assert.deepEqual(requests,['/works/1','/works/2']);
  await tick(600000);
  await page.waitForFunction(()=>!window.__downloadsPending());
  assert.equal(saved()[0].state,'done');assert.equal(saved()[0].added,2);
  await page.locator('#tabs [data-tab="activity"]').click();
  await page.locator('#download-diagnostics summary').click();
  await page.getByRole('button',{name:'Export download diagnostics'}).click();
  assert.equal(exportRequests,1,'export opens the native save picker');
  for(const [result,expected] of [[1,'Diagnostics saved'],[0,'Export cancelled'],[-1,'Could not save diagnostics']]) {
    await page.evaluate(result=>window.__diagnosticsExported(result),result);
    assert.match(await page.locator('#downloads-diagnostics-status').textContent(),new RegExp(expected));
  }
  assert.ok(diagnostics.some(d=>d.event==='queue' && d.data.cooldownMs>0),'cooldown is distinguishable from a dead queue');
  assert.ok(diagnostics.some(d=>d.event==='queue_progress' && d.data.added===2),'successful saves leave progress evidence');
  for(const record of diagnostics) for(const value of Object.values(record.data)) {
    assert.ok(typeof value==='number' || typeof value==='boolean','bridge receives no story/account/error text');
  }
  await page.close(); requests.length=0;
  setQueue('running'); await open('',0,true);
  await page.waitForFunction(()=>JSON.parse(window.ArchiveNative.query("SELECT value FROM meta WHERE key='queue'",'[]')).rows.some(row=>JSON.parse(row.value)[0].added===1));
  await tick(600000);
  await page.waitForFunction(()=>!window.__downloadsPending());
  assert.deepEqual(requests,['/works/1','/works/2'],'native downloads progress while browser archive dispatch is unavailable');
  assert.equal(saved()[0].added,2);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Cold Pause/Stop, saved pause, cooldown restoration and remaining-only downloads passed');
} finally { await browser.close();await new Promise(resolve=>server.close(resolve));db.close(); }
