import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../../app/core/store/schema.js';
import { RECORD_VISIT, HISTORY_UPDATE } from '../../app/core/store/visits.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const db = new DatabaseSync(':memory:'); db.exec(SCHEMA);
for (const id of ['1','2']) {
  db.prepare('INSERT INTO works(work_id,title,authors,chapter_count,has_text,complete) VALUES (?,?,?,2,1,1)').run(id,`Story ${id}`,'["Rowan"]');
  for (const chapter of [1,2]) db.prepare('INSERT INTO chapters(work_id,number,html,text) VALUES(?,?,?,?)').run(id,chapter,'<p>Words to read.</p>'.repeat(80),'Words to read.');
}
const historyRequests=[],errors=[],external=[];
const root=fileURLToPath(new URL('../../app/',import.meta.url));
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  try {
    if(url.pathname==='/bridge') {
      let body='';for await(const chunk of req)body+=chunk;
      const {method,args}=JSON.parse(body);
      if(method==='query')return json({rows:db.prepare(args[0]).all(...JSON.parse(args[1]))});
      if(method==='recordVisit')db.prepare(RECORD_VISIT).run(args[1],args[0]);
      if(method==='markOpened')db.prepare("INSERT INTO reading(work_id,opened_at) VALUES(?,datetime('now')) ON CONFLICT(work_id) DO UPDATE SET opened_at=excluded.opened_at").run(args[0]);
      if(method==='saveProgress')db.prepare('UPDATE reading SET chapter=?,offset=? WHERE work_id=?').run(args[1],args[2],args[0]);
      if(method==='saveMeta')db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)').run(...args);
      if(method==='saveHistory') {
        let updated=0;for(const w of JSON.parse(args[0]))updated+=db.prepare(HISTORY_UPDATE).run(w.visits,w.lastVisited??null,args[1],w.workId).changes;
        return json({updated});
      }
      return json({ok:true});
    }
    if(url.pathname==='/__net/') {
      const target=new URL(url.searchParams.get('url'));historyRequests.push(target.pathname);
      assert.equal(target.pathname,'/users/reader/readings','sync requests only listing pages');
      res.setHeader('Content-Type','text/html');return res.end('<a href="/users/reader">My Dashboard</a><ol>'+['1','2'].map(id=>`<li id="work_${id}" class="work blurb group"><h4 class="heading"><a href="/works/${id}">Story ${id}</a></h4><h4 class="viewed heading">Last visited: 24 Sep 2026 Visited ${id==='1'?10:3} times</h4></li>`).join('')+'</ol>');
    }
    if(url.pathname==='/__images/next')return json({done:true});
    if(url.pathname==='/version.txt')return res.end('reading-visits-test');
    const path=resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
    if(!path.startsWith(root)){res.writeHead(403);return res.end();}
    res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(path)]||'application/octet-stream');
    res.end(await readFile(path));
  }catch{res.setHeader('Content-Type','text/plain');res.writeHead(500);res.end('Test fixture request failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
try {
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
 await page.addInitScript(()=>{
   localStorage.setItem('archive.prefs',JSON.stringify({archiveUser:'reader'}));
   window.ArchiveNative=new Proxy({
     status:()=>JSON.stringify({hasDatabase:true,search:true}),signedIn:()=>true,
     takePendingOpen:()=>'',takePendingLink:()=>'',databaseSize:()=>1,
     ...Object.fromEntries(['query','recordVisit','markOpened','saveProgress','saveMeta','saveHistory'].map(method=>[method,(...args)=>{const req=new XMLHttpRequest();req.open('POST','/bridge',false);req.send(JSON.stringify({method,args}));return req.responseText;}]))
   },{get:(target,key)=>target[key]||(()=>'{}')});
 });
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort();});
 const count=()=>db.prepare("SELECT count(*) n FROM reading_visits WHERE work_id='1'").get().n;
 await page.goto(origin);
 await page.locator('#tabs [data-tab="library"]').click();
 const story=page.locator('#works .work-card').filter({hasText:'Story 1'});
 await story.locator('.work-title-link').click();
 await page.locator('#detail .actions .primary').waitFor();assert.equal(count(),0,'details are not reading');
 await page.locator('#detail .actions .primary').click();
 await page.locator('#workskin .userstuff').waitFor();assert.equal(count(),1);
 await page.locator('#next').click();
 await page.waitForFunction(()=>document.querySelector('#chappos').textContent.includes('2 / 2'));
 assert.equal(count(),1,'chapter changes reuse the visit');
 await page.locator('#reader-more').click();await page.locator('#reader-menu [data-go="settings"]').click();
 await page.locator('#back').click();await page.locator('#workskin .userstuff').waitFor();
 assert.equal(count(),1,'returning from Settings reuses the visit');
 await page.locator('#reader-more').click();await page.locator('#reader-menu [data-go="library"]').click();
 await story.locator('[data-act="open"]').click();await page.locator('#workskin .userstuff').waitFor();
 assert.equal(count(),2,'a fresh reading entry counts once');
 await page.locator('#reader-more').click();await page.locator('#reader-menu [data-go="library"]').click();
 await page.locator('#sort').selectOption('visits');await page.locator('#visits-help').waitFor({state:'visible'});
 await story.locator('.visit-count').filter({hasText:'2 visits · AO3 not synced + 2 Fan Folio'}).waitFor();
 await page.locator('#library-history-sync').click();await page.locator('#sync-history').click();
 await page.locator('#history-sync-status').filter({hasText:'AO3 history synced'}).waitFor();
 assert.equal(historyRequests.length,1);
 assert.equal(db.prepare("SELECT visits FROM works WHERE work_id='1'").get().visits,10);
 assert.equal(count(),2);
 await page.locator('#tabs [data-tab="library"]').click();await page.locator('#sort').selectOption('visits');
 await story.locator('.visit-count').filter({hasText:'12 visits · 10 AO3 + 2 Fan Folio'}).waitFor();
 assert.match(await page.locator('#works .work-card').first().innerText(),/Story 1/);
 await mkdir('ui-screenshots',{recursive:true});await page.screenshot({path:'ui-screenshots/combined-visits-phone.png',fullPage:true});
 await page.setViewportSize({width:900,height:940});await page.screenshot({path:'ui-screenshots/combined-visits-tablet.png',fullPage:true});
 await page.reload();await page.locator('#tabs [data-tab="library"]').click();
 await story.locator('.visit-count').filter({hasText:'12 visits · 10 AO3 + 2 Fan Folio'}).waitFor();
 assert.equal(count(),2,'reloading a collection does not fabricate reading visits');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 console.log('Combined visits, native history sync, reader navigation and persistence passed');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}
