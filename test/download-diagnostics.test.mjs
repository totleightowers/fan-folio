import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticQueue, diagnosticProgress } from '../app/download-diagnostics.js';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('queue diagnostics distinguish cooldown, overdue waits and stalled progress without library content', () => {
  const jobs = [{state:'running',author:'PRIVATE',workId:'PRIVATE'}, {state:'listing'}, {state:'paused'}, {state:'pausing'}, {state:'queued'}, {state:'done'}];
  const values = diagnosticQueue(jobs, new Set([{due:800},{due:1400}]), 3000, 500, true, 1000);
  assert.deepEqual(values, { running:1, queued:1, listing:1, paused:2, waits:2, cooldownMs:2000, progressAgeMs:500, overdueMs:200, hidden:true });
  assert.equal(JSON.stringify(values).includes('PRIVATE'),false);
  assert.deepEqual(diagnosticProgress({state:'running',total:20,added:3,failed:1,author:'PRIVATE',lastError:'PRIVATE',pages:NaN}), {state:2,total:20,added:3,failed:1});
});

test('native journal survives restart, rotates at its bound and rejects sensitive fields', t => {
  if (spawnSync('javac',['-version']).error) { t.skip('JDK unavailable'); return; }
  const dir = mkdtempSync(join(tmpdir(),'folio-diagnostics-'));
  try {
    for (const name of ['DiagnosticJournal','DiagnosticFields']) writeFileSync(join(dir,name+'.java'),readFileSync(new URL(`../android/src/org/fanfolio/${name}.java`,import.meta.url)));
    writeFileSync(join(dir,'Check.java'),`package org.fanfolio;
import java.io.*; import java.nio.charset.StandardCharsets; import java.util.*;
public class Check {
 static void check(boolean ok) { if(!ok)throw new AssertionError(); }
 public static void main(String[] args) throws Exception {
  File root=new File(args[0],"journal");
  DiagnosticJournal journal=new DiagnosticJournal(root,64);
  String record="{\\"event\\":\\"start\\"}";
  journal.append(record);
  try(FileOutputStream broken=new FileOutputStream(new File(root,"current.jsonl"),true)) { broken.write("partial".getBytes(StandardCharsets.UTF_8)); }
  journal=new DiagnosticJournal(root,64);
  check(new String(journal.snapshot(),StandardCharsets.UTF_8).equals(record+"\\n"));
  for(int i=0;i<30;i++)journal.append("{\\"i\\":"+i+"}");
  String report=new String(journal.snapshot(),StandardCharsets.UTF_8);
  check(journal.snapshot().length<=128 && report.contains("{\\"i\\":29}"));
  check(!report.contains("start"));
  for(String line:report.trim().split("\\n"))check(line.startsWith("{") && line.endsWith("}"));
  try { journal.append(new String(new char[65])); throw new AssertionError(); } catch(IOException expected) {}
  check(Arrays.equals(journal.snapshot(),new DiagnosticJournal(root,64).snapshot()));
  Map<String,Object> fields=new HashMap<>();
  fields.put("running",3); fields.put("hidden",true); fields.put("title","PRIVATE");
  fields.put("added","PRIVATE"); fields.put("failed",Double.NaN); fields.put("page",Double.POSITIVE_INFINITY);
  fields.put("pages",new HashMap<>()); fields.put("cooldownMs",1e20);
  Map<String,Object> safe=DiagnosticFields.clean("queue",fields);
  check(safe.size()==2 && safe.get("running").equals(3) && safe.get("hidden").equals(true));
  check(DiagnosticFields.clean("PRIVATE",fields)==null);
 }
}`);
    const built=spawnSync('javac',['-d',dir,...['DiagnosticJournal','DiagnosticFields','Check'].map(n=>join(dir,n+'.java'))],{encoding:'utf8'});
    assert.equal(built.status,0,built.stderr);
    const run=spawnSync('java',['-cp',dir,'org.fanfolio.Check',dir],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('native request tracing closes exactly once on EOF, cancellation, missing body or stream error', t => {
  if (spawnSync('javac',['-version']).error) { t.skip('JDK unavailable'); return; }
  const source=readFileSync(new URL('../android/src/org/fanfolio/DownloadDiagnostics.java',import.meta.url),'utf8');
  const request=source.slice(source.indexOf('    static final class Request'),source.lastIndexOf('\n}'));
  const dir=mkdtempSync(join(tmpdir(),'folio-request-diagnostics-'));
  try {
    writeFileSync(join(dir,'Check.java'),`import java.io.*; import java.util.*; import java.util.concurrent.atomic.AtomicLong;
public class Check {
 static class SystemClock { static long elapsedRealtime(){return 1000;} }
 static AtomicLong requests=new AtomicLong(), activeRequests=new AtomicLong();
 static List<Map<String,Object>> endings=new ArrayList<>();
 static void event(String event,Object... pairs) {
  if(!event.equals("request_end"))return;
  Map<String,Object> fields=new HashMap<>();
  for(int i=0;i<pairs.length;i+=2)fields.put((String)pairs[i],pairs[i+1]);
  endings.add(fields);
 }
 ${request}
 static void check(boolean ok){if(!ok)throw new AssertionError();}
 public static void main(String[] args)throws Exception {
  Request request=new Request(); request.headers(200);
  InputStream stream=request.wrap(new ByteArrayInputStream(new byte[]{1,2,3,4}));
  check(activeRequests.get()==1 && stream.read()==1);
  check(stream.read(new byte[3])==3 && stream.read()==-1);stream.close();
  check(endings.size()==1 && endings.get(0).get("outcome").equals(0) && endings.get(0).get("bytes").equals(4L));
  Request cancelled=new Request();cancelled.wrap(new ByteArrayInputStream(new byte[9])).close();
  check(endings.get(1).get("outcome").equals(1));
  Request missing=new Request();check(missing.wrap(null)==null);
  Request failed=new Request();
  try { failed.wrap(new InputStream(){public int read()throws IOException{throw new IOException("PRIVATE");}}).read();throw new AssertionError(); }
  catch(IOException expected){}
  check(endings.get(3).get("outcome").equals(2) && activeRequests.get()==0);
  check(!endings.toString().contains("PRIVATE"));
 }
}`);
    const built=spawnSync('javac',[join(dir,'Check.java')],{encoding:'utf8'});
    assert.equal(built.status,0,built.stderr);
    const run=spawnSync('java',['-cp',dir,'Check'],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
