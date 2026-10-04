import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveTransport } from '../app/archive-transport.js';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('native response polling completes downloads without browser fetch or timer delivery', async () => {
  let serial=0;
  const responses=new Map(), started=[];
  const transport=createArchiveTransport({
    native:{ startArchiveRequest:url=>{started.push(url);return ++serial;}, takeArchiveResponse:id=>responses.get(id)||'' },
    fetchPage:()=>assert.fail('must not dispatch through WebView'),
    setTimer:()=>1, clearTimer:()=>{}, // callbacks never run, as on the affected device
  });
  let complete=false;
  const first=transport.request('https://archiveofourown.org/works/1').then(r=>{complete=true;return r;});
  transport.poll();await Promise.resolve();assert.equal(complete,false);
  responses.set(1,JSON.stringify({status:200,body:'A synthetic story'}));
  transport.poll();
  const result=await first;
  assert.equal(await result.text(),'A synthetic story');assert.equal(result.ok,true);
  assert.equal(transport.pendingCount(),0);
  const second=transport.request('https://archiveofourown.org/works/2');
  responses.set(2,JSON.stringify({status:429,body:'Retry later'}));transport.poll();
  const limited=await second;
  assert.equal(limited.status,429);assert.equal(limited.ok,false);
  assert.equal(started.length,2);
});

test('transport handles immediate completion, malformed replies, start failure and older shells', async () => {
  const build=(start,take)=>createArchiveTransport({native:{startArchiveRequest:start,takeArchiveResponse:take},setTimer:()=>1,clearTimer:()=>{}});
  assert.equal(await (await build(()=>1,()=>'{"status":200,"body":"ok"}').request('test')).text(),'ok');
  const broken=build(()=>1,()=>'{"unexpected":true}');
  await assert.rejects(broken.request('test'),/Invalid archive response/);assert.equal(broken.pendingCount(),0);
  await assert.rejects(build(()=>{throw new Error('capacity');},()=>assert.fail()).request('test'),/capacity/);
  const fallback=createArchiveTransport({native:null,fetchPage:async url=>url});
  assert.equal(await fallback.request('old shell'),'old shell');
});

test('native worker admits bounded async requests, delivers once and discards obsolete page results', t => {
  if(spawnSync('javac',['-version']).error){t.skip('JDK unavailable');return;}
  const dir=mkdtempSync(join(tmpdir(),'folio-archive-worker-'));
  try {
    writeFileSync(join(dir,'ArchiveRequests.java'),readFileSync(new URL('../android/src/org/fanfolio/ArchiveRequests.java',import.meta.url)));
    writeFileSync(join(dir,'Check.java'),`package org.fanfolio;
import java.util.*; import java.util.concurrent.*;
public class Check {
 static void check(boolean ok){if(!ok)throw new AssertionError();}
 public static void main(String[] args)throws Exception{
  List<Runnable> tasks=new ArrayList<>(); int[] notices={0}, calls={0};
  ArchiveRequests requests=new ArchiveRequests(tasks::add,()->notices[0]++);
  int first=requests.start(()->{calls[0]++;return "ok";});
  check(requests.take(first).equals("") && calls[0]==0);
  tasks.remove(0).run();check(calls[0]==1 && notices[0]==1);
  check(requests.take(first).equals("ok"));check(requests.take(first).contains("502"));
  for(int n=0;n<4;n++)requests.start(()->"body");
  try{requests.start(()->"overflow");throw new AssertionError();}catch(RejectedExecutionException expected){}
  requests.discard();for(Runnable task:tasks)task.run();tasks.clear();check(notices[0]==1);
  int failed=requests.start(()->{throw new Exception("PRIVATE");});tasks.remove(0).run();
  String error=requests.take(failed);check(error.contains("502") && !error.contains("PRIVATE"));
  ExecutorService worker=Executors.newSingleThreadExecutor();
  CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1),done=new CountDownLatch(1);
  try{
   ArchiveRequests live=new ArchiveRequests(worker,()->done.countDown());
   int id=live.start(()->{entered.countDown();release.await();return "done";});
   check(entered.await(5,TimeUnit.SECONDS));check(live.take(id).equals(""));
   release.countDown();check(done.await(5,TimeUnit.SECONDS));check(live.take(id).equals("done"));
  }finally{release.countDown();worker.shutdownNow();}
 }
}`);
    const build=spawnSync('javac',['-d',dir,join(dir,'ArchiveRequests.java'),join(dir,'Check.java')],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);
    const run=spawnSync('java',['-cp',dir,'org.fanfolio.Check'],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
