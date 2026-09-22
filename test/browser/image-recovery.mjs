import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../../app/core/store/schema.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);
const source = 'https://i.imgur.com/ViPqvAJ.png';
const held = 'https://example.org/kept.png';
const goodHash = 'a'.repeat(64), recoveredHash = 'b'.repeat(64);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lGkAAAAASUVORK5CYII=', 'base64');
db.prepare("INSERT INTO works(work_id,title,authors,has_text,chapter_count,complete,words) VALUES('1','Pictures in a story','[\"Rowan\"]',1,1,1,500)").run();
db.prepare('INSERT INTO chapters(work_id,number,html,text) VALUES(?,?,?,?)').run('1',1,
  `<p>Before the illustrations.</p><img src="${held}" alt="Saved illustration"><img src="${source}" alt="Author’s illustration"><p>After the illustrations.</p>`, 'Illustrated story');
db.exec("INSERT INTO reading(work_id,chapter,opened_at) VALUES('1',1,'2026-09-22')");
db.prepare("INSERT INTO images(work_id,url,sha256,mime,bytes,status) VALUES('1',?,?, 'image/png',?,'stored')").run(held,goodHash,png);
let attempts = 0, resets = 0, releaseFirst;
const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
const requested = [], external = [], errors = [];
const root = fileURLToPath(new URL('../../app/', import.meta.url));
const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = value => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value)); };
  try {
    if (url.pathname === '/bridge') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { sql,args } = JSON.parse(body);
      return json({rows:db.prepare(sql).all(...JSON.parse(args))});
    }
    if (url.pathname === '/__images/retry') {
      resets++;
      db.prepare("DELETE FROM images WHERE work_id=? AND status!='stored'").run(url.searchParams.get('workId'));
      return json({reset:1});
    }
    if (url.pathname === '/__images/next') {
      requested.push(Object.fromEntries(url.searchParams));
      if (db.prepare('SELECT 1 FROM images WHERE url=?').get(source)) return json({done:true});
      attempts++;
      if (attempts === 1) {
        await firstResponse;
        db.prepare("INSERT INTO images(work_id,url,status) VALUES('1',?,'failed')").run(source);
        return json({url:source,error:'Image host answered 429'});
      }
      db.prepare("INSERT INTO images(work_id,url,sha256,mime,bytes,status) VALUES('1',?,?,'image/png',?,'stored')").run(source,recoveredHash,png);
      return json({url:source,sha256:recoveredHash,proxied:true});
    }
    if (url.pathname.startsWith('/img/')) {
      const row = db.prepare('SELECT bytes FROM images WHERE sha256=?').get(url.pathname.slice(5));
      if (!row) {res.writeHead(404);return res.end();}
      res.setHeader('Content-Type','image/png');return res.end(row.bytes);
    }
    if (url.pathname === '/version.txt') return res.end('3.12.0-test');
    const path = resolve(root, '.'+(url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!path.startsWith(root)) {res.writeHead(403);return res.end();}
    res.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(path)] || 'application/octet-stream');
    res.end(await readFile(path));
  } catch (e) {res.writeHead(500);res.end(e.message);}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage({viewport:{width:900,height:940},hasTouch:true});
  await page.addInitScript(() => {
    window.ArchiveNative = new Proxy({
      status: () => JSON.stringify({hasDatabase:true,search:true}),
      query(sql,args) { const req=new XMLHttpRequest();req.open('POST','/bridge',false);req.send(JSON.stringify({sql,args}));return req.responseText; },
      signedIn: () => false, takePendingOpen: () => '', takePendingLink: () => '', databaseSize: () => 1,
    },{get:(target,key) => target[key] || (() => '{}')});
  });
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.goto(origin);
  const firstRequest = page.waitForRequest(r => r.url().includes('/__images/next?'));
  await page.locator('.resume-action').first().click();
  await firstRequest;
  await page.locator('#reader-more').click();
  assert.equal(await page.locator('#reader-menu').isVisible(),true,'the reader responds while an image request is still pending');
  releaseFirst();
  await page.locator('#reader-images-status').filter({hasText:'1 still unavailable'}).waitFor({state:'attached'});
  assert.equal(await page.locator('#workskin img[data-stored="1"]').count(),1);
  await page.locator('#reader-images').click();
  await page.waitForFunction(() => document.querySelectorAll('#workskin img[data-stored="1"]').length === 2);
  assert.equal(await page.locator('#workskin img').nth(1).getAttribute('alt'),'Author’s illustration');
  assert.equal(resets,1);assert.equal(attempts,2);
  assert.equal(db.prepare('SELECT sha256 FROM images WHERE url=?').get(held).sha256,goodHash);
  assert.ok(requested.every(r => r.workId==='1' && r.chapter==='1' && r.proxy==='true'));
  await page.locator('#reader-more').click();
  await page.locator('#reader-menu [data-go="settings"]').click();
  await page.locator('#settings [data-settings-page="reading"]').click();
  await page.locator('#imgur-proxy').uncheck();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('archive.prefs')).imgurProxy),false);
  await page.reload();
  await page.locator('.resume-action').first().click();
  await page.waitForFunction(() => document.querySelectorAll('#workskin img').length === 2 && [...document.querySelectorAll('#workskin img')].every(img => img.complete && img.naturalWidth>0));
  assert.equal(attempts,2,'reopening renders the saved image without another upstream attempt');
  assert.ok(requested.some(r => r.proxy==='false'),'proxy opt-out persists after reload');
  assert.deepEqual(errors,[]);
  assert.deepEqual(external,[],'the browser never contacts Imgur, AO3 or the proxy directly');
  console.log('Image retry, cached reopening, preserved illustrations and proxy settings passed');
} finally {
  releaseFirst(); await browser.close(); await new Promise(resolve => server.close(resolve)); db.close();
}
