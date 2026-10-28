import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise the shipped cookie adapter with a synthetic connection and cookie jar.
// No archive requests, account cookies or device state are used.
test('native responses update scoped cookies, including redirects, without exposing them to JavaScript', t => {
  if (spawnSync('javac', ['-version']).error) { t.skip('JDK unavailable'); return; }
  const source = readFileSync(new URL('../android/src/org/fanfolio/FolioRuntime.java', import.meta.url), 'utf8');
  const method = signature => {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, signature);
    return source.slice(start, source.indexOf('\n    }', start) + 6);
  };
  const methods = [method('private String archiveCookies(String url)'),
    method('private void acceptArchiveCookies('), method('private static boolean isArchiveHost('),
    method('private WebResourceResponse respond('), method('private Map<String, String> headers()')]
    .join('\n').replaceAll('android.webkit.CookieManager', 'Jar');
  const dir = mkdtempSync(join(tmpdir(), 'folio-session-'));
  try {
    writeFileSync(join(dir, 'Check.java'), `
import java.net.*; import java.io.*; import java.util.*;
public class Check {
 static final String ORIGIN="https://fanfolio.local";
 static class ArchiveHttp {
  static void checked(String url)throws IOException {
   URL u=new URL(url); if(!u.getProtocol().equals("https") || !isArchiveHost(u.getHost()))throw new IOException();
  }
 }
 static class Jar {
  static final Jar jar=new Jar(); final Map<String,String> cookies=new HashMap<>();
  int flushes; static Jar getInstance(){return jar;}
  String getCookie(String url){return cookies.get(url);}
  void setCookie(String url,String value){cookies.merge(url,value,(a,b)->a+"; "+b);}
  void flush(){flushes++;}
 }
 static class Connection extends HttpURLConnection {
  Map<String,List<String>> fields=new HashMap<>(); int status=302;
  Connection(String url)throws Exception{super(new URL(url));}
  public void connect(){} public void disconnect(){} public boolean usingProxy(){return false;}
  public int getResponseCode(){return status;}
  public Map<String,List<String>> getHeaderFields(){return fields;}
  public String getHeaderField(String key){List<String> v=fields.get(key);return v==null?null:v.get(0);}
  public InputStream getErrorStream(){return new ByteArrayInputStream(new byte[0]);}
 }
 static class WebResourceResponse {
  Map<String,String> headers; int status;
  WebResourceResponse(String mime,String encoding,int code,String reason,Map<String,String> h,InputStream in){headers=h;status=code;}
 }
 ${methods}
 static void check(boolean ok){if(!ok)throw new AssertionError();}
 public static void main(String[] args)throws Exception {
  Check runtime=new Check(); Connection redirect=new Connection("https://archiveofourown.org/works/1");
  redirect.fields.put("Set-Cookie",Arrays.asList("session=fresh; Path=/", "preference=yes; Path=/works"));
  runtime.acceptArchiveCookies(redirect.getURL().toString(), redirect.fields.get("Set-Cookie"));
  check(Jar.jar.flushes==1);
  check(runtime.archiveCookies(redirect.getURL().toString()).contains("session=fresh"));
  check(runtime.archiveCookies("https://download.archiveofourown.org/file").equals(""));
  Connection unrelated=new Connection("https://notarchiveofourown.org/");
  unrelated.fields.put("Set-Cookie",Arrays.asList("session=bad")); runtime.acceptArchiveCookies(unrelated.getURL().toString(), unrelated.fields.get("Set-Cookie"));
  check(Jar.jar.flushes==1 && runtime.archiveCookies(unrelated.getURL().toString()).equals(""));
  redirect.status=429; redirect.fields.put("Retry-After",Arrays.asList("1800"));
  WebResourceResponse limited=runtime.respond(redirect);
  check(limited.status==429 && "1800".equals(limited.headers.get("Retry-After")));
  check(!limited.headers.containsKey("Set-Cookie"));
 }
}`);
    const build = spawnSync('javac', ['-d', dir, join(dir, 'Check.java')], {encoding: 'utf8'});
    assert.equal(build.status, 0, build.stderr);
    const run = spawnSync('java', ['-cp', dir, 'Check'], {encoding: 'utf8'});
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
