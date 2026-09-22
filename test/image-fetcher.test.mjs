import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../app/core/store/schema.js';

const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
const transport = new URL('../android/src/org/fanfolio/ImageFetcher.java', import.meta.url);
test('native image transport handles real Imgur placeholders, redirects, privacy, limits and fallback', t => {
  if (spawnSync('javac', ['-version']).error) { t.skip('JDK unavailable'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'folio-images-'));
  try {
    const harness = `package org.fanfolio;
import java.net.*; import java.io.*; import java.util.*; import java.nio.file.*;
public class ImageCheck {
 static byte[] png=Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lGkAAAAASUVORK5CYII=");
 static class Reply extends HttpURLConnection {
  int code; String mime, location; byte[] bytes; long length=-1; boolean disconnected;
  Reply(int code,String mime,byte[] bytes)throws Exception {super(new URL("https://example.org"));this.code=code;this.mime=mime;this.bytes=bytes;}
  public int getResponseCode(){return code;} public String getContentType(){return mime;}
  public long getContentLengthLong(){return length;}
  public String getHeaderField(String name){return name.equals("Location")?location:null;}
  public InputStream getInputStream(){return new ByteArrayInputStream(bytes);}
  public void connect(){} public boolean usingProxy(){return false;} public void disconnect(){disconnected=true;}
 }
 static class Wire implements ImageFetcher.Connections {
  List<String> urls=new ArrayList<>(); ArrayDeque<Reply> replies=new ArrayDeque<>();
  public HttpURLConnection open(URL url)throws IOException {urls.add(url.toString());if(replies.isEmpty())throw new IOException("unexpected request");return replies.remove();}
  ImageFetcher fetcher(){return new ImageFetcher(this,"FanFolio test");}
 }
 static void check(boolean ok,String why){if(!ok)throw new AssertionError(why);}
 static void fails(Wire w,String url,boolean proxy)throws Exception {try{w.fetcher().fetch(url,proxy);throw new AssertionError("accepted bad image");}catch(IOException expected){}}
 public static void main(String[] args)throws Exception {
  String source="https://i.imgur.com/ViPqvAJ.png", proxy="https://"+ImageFetcher.PROXY_HOST+"/ViPqvAJ.png";
  Wire good=new Wire();Reply direct=new Reply(200,"image/png",png);good.replies.add(direct);
  check(Arrays.equals(good.fetcher().fetch(source,true).bytes,png),"preserve original bytes");
  check(good.urls.size()==1 && direct.disconnected,"no proxy for a good image");
  check(direct.getRequestProperty("Cookie")==null && direct.getRequestProperty("Referer")==null && direct.getRequestProperty("Authorization")==null,"no credentials or reading URL");
  check(!direct.getInstanceFollowRedirects(),"redirects checked individually");
  for(String fixture:args) {
   byte[] blocked=Files.readAllBytes(Paths.get(fixture));
   Wire recovery=new Wire(); recovery.replies.add(new Reply(200,"image/png",blocked));recovery.replies.add(new Reply(200,"image/png",png));
   check(recovery.fetcher().fetch(source,true).proxied,"image-shaped placeholder triggers fallback");
   check(recovery.urls.equals(Arrays.asList(source,proxy)),"only image address reaches named proxy");
   Wire absent=new Wire();absent.replies.add(new Reply(200,"image/png",blocked));absent.replies.add(new Reply(200,"image/png",blocked));fails(absent,source,true);
  }
  Wire off=new Wire();off.replies.add(new Reply(403,"text/html",png));fails(off,source,false);check(off.urls.size()==1,"off means no proxy");
  Wire foreign=new Wire();foreign.replies.add(new Reply(404,"text/html",png));fails(foreign,"https://imgur.com.evil.example/picture.png",true);check(foreign.urls.size()==1,"other hosts are never proxied");
  Wire query=new Wire();query.replies.add(new Reply(403,"text/html",png));query.replies.add(new Reply(200,"image/gif",png));query.fetcher().fetch("http://imgur.com/ViPqvAJ.png?private=value",true);check(query.urls.equals(Arrays.asList(source,proxy)),"normalise legacy host, upgrade HTTPS, strip query");
  check(ImageFetcher.imgurImage(new URL("https://user:secret@i.imgur.com/ViPqvAJ.png"))==null,"credentials cannot reach proxy");
  check(ImageFetcher.imgurImage(new URL("https://imgur.com/a/ViPqvAJ"))==null,"gallery pages are not image addresses");
  Wire redirect=new Wire();Reply moved=new Reply(302,"text/html",png);moved.location="https://cdn.example/image.png";redirect.replies.add(moved);redirect.replies.add(new Reply(200,"image/png",png));redirect.fetcher().fetch("https://example.org/photo",true);check(moved.disconnected,"redirect response closed");
  Wire downgrade=new Wire();Reply insecure=new Reply(302,"text/html",png);insecure.location="http://example.org/image.png";downgrade.replies.add(insecure);fails(downgrade,"https://example.org/photo",true);check(downgrade.urls.size()==1,"no HTTP downgrade");
  Wire escaping=new Wire();escaping.replies.add(new Reply(403,"text/html",png));Reply outside=new Reply(302,"text/html",png);outside.location="https://other.example/image.png";escaping.replies.add(outside);fails(escaping,source,true);check(escaping.urls.size()==2,"proxy cannot redirect to another service");
  Wire loop=new Wire();for(int i=0;i<5;i++){Reply r=new Reply(302,"text/html",png);r.location="/again";loop.replies.add(r);}fails(loop,"https://example.org/photo",false);check(loop.urls.size()==5,"redirects bounded");
  Wire html=new Wire();html.replies.add(new Reply(200,"text/html",png));fails(html,"https://example.org/photo",false);
  Wire large=new Wire();Reply huge=new Reply(200,"image/png",png);huge.length=ImageFetcher.MAX_BYTES+1;large.replies.add(huge);fails(large,"https://example.org/photo",false);
  Wire streamed=new Wire();streamed.replies.add(new Reply(200,"image/png",new byte[ImageFetcher.MAX_BYTES+1]));fails(streamed,"https://example.org/photo",false);
  Wire empty=new Wire();empty.replies.add(new Reply(200,"image/png",new byte[0]));fails(empty,"https://example.org/photo",false);
  System.out.println("Image transport checks passed");
 }
}`;
    writeFileSync(join(dir, 'ImageCheck.java'), harness);
    const compile = spawnSync('javac', ['-d', dir, fileURLToPath(transport), join(dir, 'ImageCheck.java')], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync('java', ['-cp', dir, 'org.fanfolio.ImageCheck',
      fileURLToPath(new URL('fixtures/images/imgur-region.png', import.meta.url)),
      fileURLToPath(new URL('fixtures/images/imgur-removed.png', import.meta.url))], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function sqlFrom(start, end) {
  const block = java.slice(java.indexOf(start), java.indexOf(end, java.indexOf(start)));
  return [...block.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(m => JSON.parse(m[0])).join('');
}
test('native image selection retries legacy failures and respects the cooldown', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SCHEMA);
    for (const [url,status,date] of [['good','stored',null],['old','dead',null],['recent','failed',new Date().toISOString()],['due','failed','2020-01-01']]) {
      db.prepare('INSERT INTO images(work_id,url,status,fetched_at) VALUES(?,?,?,?)').run('1',url,status,date);
    }
    const query = sqlFrom('"SELECT url FROM images WHERE work_id = ? AND "', 'new String[]{ workId }');
    assert.deepEqual(db.prepare(query).all('1').map(r => r.url).sort(), ['good','recent']);
  } finally { db.close(); }
});
test('manual recovery preserves valid copies and other works', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SCHEMA);
    for (const [id,url,status,sha] of [['1','good','stored','goodhash'],['1','blocked','stored','bad1'],['1','failed','failed',null],['2','other','failed',null]]) {
      db.prepare('INSERT INTO images(work_id,url,status,sha256) VALUES(?,?,?,?)').run(id,url,status,sha);
    }
    const where = sqlFrom('"work_id = ? AND (status IS NULL', 'new String[]{ workId, ImageFetcher.REGION_IMAGE');
    db.prepare('DELETE FROM images WHERE '+where).run('1','bad1','bad2');
    assert.deepEqual(db.prepare('SELECT url FROM images ORDER BY url').all().map(r => r.url), ['good','other']);
  } finally { db.close(); }
});
