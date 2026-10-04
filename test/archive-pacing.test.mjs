import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const app=readFileSync(new URL('../app/app.js',import.meta.url),'utf8');
const method=name=>{const from=app.indexOf(name);return app.slice(from,app.indexOf('\n}\n',from)+3);};
const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
function fixture(archiveRequest=()=>assert.fail()) {
  let now=1000;
  const waits=[];
  const untilDue=ms=>new Promise(resolve=>waits.push({due:now+ms,resolve}));
  const factory=new Function('Date','untilDue','archiveRequest',`
    let archiveTurn=Promise.resolve(), lastArchiveAt=0, coolUntil=0;
    const nextGap=()=>100, keepPacing=()=>{}, wait=untilDue, retryDelay=()=>100;
    const slowDown=()=>{coolUntil=Math.max(coolUntil,Date.now()+300000);};
    const isTransient=()=>false;
    ${method('function paced(run)')}
    ${method('async function archivePage(')}
    return {paced,archivePage,setCooldown:until=>{coolUntil=until;},setLast:at=>{lastArchiveAt=at;}};
  `);
  return {...factory({now:()=>now},untilDue,archiveRequest),waits,
    tick:async time=>{now=time;for(const entry of waits.splice(0)){
      if(entry.due<=now)entry.resolve();else waits.push(entry);
    }await flush();}};
}

test('a cooldown extended during a pending wait is checked again before a request starts',async()=>{
  const f=fixture(),sent=[];
  f.setLast(1000);
  const first=f.paced(async()=>sent.push('first'));
  const second=f.paced(async()=>sent.push('second'));
  await flush();assert.equal(f.waits[0].due,1100);
  f.setCooldown(2000);
  await f.tick(1100);assert.deepEqual(sent,[]);assert.equal(f.waits[0].due,2000);
  await f.tick(1999);assert.deepEqual(sent,[]);
  await f.tick(2000);await first;assert.deepEqual(sent,['first']);
  await f.tick(2099);assert.deepEqual(sent,['first']);
  await f.tick(2100);await second;assert.deepEqual(sent,['first','second']);
});

test('listing 429 response publishes cooldown before another caller can take its turn',async()=>{
  let finishBody;
  const body=new Promise(resolve=>{finishBody=resolve;});
  const f=fixture(async()=>({status:429,ok:false,text:()=>body}));
  const listing=assert.rejects(f.archivePage('synthetic'),/429/);
  let sent=false;
  const work=f.paced(async()=>{sent=true;});
  await flush();assert.equal(sent,false);assert.equal(f.waits.length,0,'next caller still waits for the whole response');
  finishBody('Retry later');await flush();await listing;
  assert.equal(sent,false);assert.equal(f.waits[0].due,301000);
  await f.tick(300999);assert.equal(sent,false);
  await f.tick(301000);await work;assert.equal(sent,true);
});
