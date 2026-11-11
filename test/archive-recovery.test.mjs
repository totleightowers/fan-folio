import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecoverableWork, recoveredWork, snapshotForWork, RECOVERY_ORIGINS, resolveRecoverableChapter } from '../app/core/ao3/recovery.js';
import { createArchiveTransport, createPublicRecoveryRequests } from '../app/archive-transport.js';

const html = (id = '123', chapters = '1/1') => `<html><li class="share"><a href="/works/${id}">Share</a></li>
<dl class="work meta group"><dd class="stats"><dl><dd class="chapters">${chapters}</dd></dl></dd></dl>
<div id="workskin"><h2 class="title heading">A test story</h2><div id="chapters"><div class="userstuff"><p>A complete synthetic chapter.</p></div></div></div></html>`;
const response = (status, body, headers = {}) => ({status, ok:status===200, text:async()=>body, headers:new Headers(headers)});
const snapshot = (url = 'https://archiveofourown.org/works/123') => ({available:true,status:'200',url:`http://web.archive.org/web/20261001020304/${url}`});

test('successful AO3 download makes no fallback requests', async () => {
  const out=await fetchRecoverableWork('123',{request:async()=>response(200,html()),requestPublic:()=>assert.fail('unnecessary fallback')});
  assert.equal(out.source,'ao3'); assert.equal(out.work.title,'A test story');
});
test('an outage tries alternates sequentially and stops after a valid work', async () => {
  const urls=[];
  const out=await fetchRecoverableWork('123',{request:async()=>response(418,''),requestPublic:async url=>{
    urls.push(url); return response(200,urls.length===1?'<html>Maintenance</html>':html());
  }});
  assert.equal(out.source,'mirror'); assert.equal(urls.length,2);
  assert.ok(urls[0].startsWith(RECOVERY_ORIGINS[0])); assert.ok(urls[1].startsWith(RECOVERY_ORIGINS[1]));
});
test('Wayback follows validated snapshot URLs, stores the date, and rejects partial pages', async () => {
  const urls=[];
  const out=await fetchRecoverableWork('123',{request:async()=>response(503,''),requestPublic:async url=>{
    urls.push(url);
    if(url.startsWith('https://archive.org/')) return response(200,JSON.stringify({archived_snapshots:{closest:snapshot()}}));
    if(url.startsWith('https://web.archive.org/')) return response(200,html());
    return response(200,html('123','2/2'));
  }});
  assert.equal(out.source,'wayback'); assert.equal(out.snapshotAt,'20261001020304');
  assert.match(out.sourceUrl,/20261001020304id_/);
  assert.equal(recoveredWork(html('123','2/2'),'123'),null);
  assert.equal(recoveredWork(html('456'),'123'),null);
  assert.equal(recoveredWork('<html>Please sign in</html>','123'),null);
});
test('rate limits skip live aliases but can recover an existing public snapshot', async () => {
  const out=await fetchRecoverableWork('123',{request:async()=>response(429,''),requestPublic:async url=>{
    assert.ok(!RECOVERY_ORIGINS.some(origin=>url.startsWith(origin)));
    return url.startsWith('https://archive.org/') ? response(200,JSON.stringify({archived_snapshots:{closest:snapshot()}})) : response(200,html());
  }});
  assert.equal(out.source,'wayback');
});
test('explicit login refusal does not forward the request to a public mirror', async () => {
  await assert.rejects(fetchRecoverableWork('123',{request:async()=>response(401,''),requestPublic:()=>assert.fail('private request')}),/sign in/);
});
test('snapshot metadata cannot substitute another work, credentials or a foreign host', () => {
  for(const url of ['https://evil.example/works/123','https://archiveofourown.org/works/456','https://u:p@archiveofourown.org/works/123','https://archiveofourown.org/works/123?token=private']) assert.equal(snapshotForWork(snapshot(url),'123'),null);
  assert.equal(snapshotForWork({...snapshot(),url:'https://web.archive.org.evil.example/web/20261001020304/https://archiveofourown.org/works/123'},'123'),null);
});
test('unavailable captures terminate with a useful error instead of storing an error page', async () => {
  let calls=0;
  await assert.rejects(fetchRecoverableWork('123',{request:async()=>response(404,''),requestPublic:async()=>{calls++;return response(200,'<html>unavailable</html>');}}),/No complete readable copy/);
  assert.equal(calls,5);
});
test('native public recovery uses its separate entry point and the shared suspended-page polling path', async () => {
  let publicCalls=0,raw='';
  const native={startArchiveRequest:()=>assert.fail('used authenticated entry'),startRecoveryRequest:()=>{publicCalls++;return 3;},takeArchiveResponse:()=>{const r=raw;raw='';return r;}};
  const transport=createArchiveTransport({native,setTimer:()=>1,clearTimer:()=>{}});
  const pending=transport.requestPublic('https://archive.org/wayback/available?url=example');
  raw=JSON.stringify({status:200,body:'snapshot'});transport.poll();
  assert.equal(await (await pending).text(),'snapshot');assert.equal(publicCalls,1);
});

test('chapter-only links can identify the work from a public capture', async () => {
  const result=await resolveRecoverableChapter('456',{request:async()=>response(503,''),requestPublic:async url=>{
    if(url.startsWith('https://archive.org/')) return response(200,JSON.stringify({archived_snapshots:{closest:snapshot('https://archiveofourown.org/chapters/456')}}));
    if(url.startsWith('https://web.archive.org/')) return response(200,html('123'));
    return response(503,'');
  }});
  assert.equal(result,'123');
});

test('adding a link through the actual API saves the recovered work and its provenance', async () => {
  const before=globalThis.window;
  let id=0,payload; const ready=new Map(),calls=[];
  const native={
    status:()=>JSON.stringify({hasDatabase:true,nativeArchiveRequests:true}),
    startArchiveRequest(url){calls.push(url);ready.set(++id,JSON.stringify({status:503,body:'outage'}));return id;},
    startRecoveryRequest(url){calls.push(url);const body=url.startsWith('https://archive.org/')?JSON.stringify({archived_snapshots:{closest:snapshot()}}):url.startsWith('https://web.archive.org/')?html():'outage';ready.set(++id,JSON.stringify({status:body==='outage'?503:200,body}));return id;},
    takeArchiveResponse(id){const value=ready.get(id)||'';ready.delete(id);return value;},
    saveWork(json){payload=JSON.parse(json);return '{"ok":true}';},
  };
  globalThis.window={ArchiveNative:native,dispatchEvent:()=>{}};
  try {
    const api=await import('../app/api.js?recovery-integration');
    const out=await api.addWork('https://archiveofourown.org/works/123');
    assert.equal(out.source,'wayback');assert.equal(payload.workId,'123');
    assert.equal(payload.source,'wayback');assert.match(payload.sourceUrl,/20261001020304id_/);
    assert.match(payload.chapters[0].text,/synthetic chapter/);
    assert.ok(calls[0].startsWith('https://archiveofourown.org/'));
  } finally { globalThis.window=before; }
});

test('Wayback rate limits cool down both lookup and capture hosts across queued works', async () => {
  let calls=0,now=0;
  const request=createPublicRecoveryRequests(async()=>{calls++;return response(429,'',{'Retry-After':'1800'});},()=>now);
  await request('https://archive.org/wayback/available?url=example');
  now=1000;await request('https://web.archive.org/web/20261001020304id_/https://archiveofourown.org/works/123');
  assert.equal(calls,1);
  now=1800001;await request('https://archive.org/wayback/available?url=example');
  assert.equal(calls,2);
});
