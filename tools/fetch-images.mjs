/**
 * Capture the images a work points at.
 *
 * Works embed images hosted anywhere — Twitter, Discord, dead Tumblr CDNs.
 * They are part of the work: a chat fic whose selca is a broken-image icon is
 * not the work the author posted. They are also the most perishable part of
 * it, so they are copied into the archive rather than hotlinked.
 *
 * These hosts are not AO3, so AO3's pacing does not apply — but they are still
 * fetched one at a time and politely.
 */
import { DatabaseSync } from 'node:sqlite';
import { createLimiter } from '../app/core/queue.js';
import { SCHEMA } from '../app/core/store/schema.js';
import { imageUrls } from '../app/core/ao3/parse.js';

const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');
db.exec(SCHEMA);

const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const MAX_BYTES = 8 * 1024 * 1024;

const chapters = ids.length
  ? db.prepare(`SELECT work_id, html FROM chapters WHERE work_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  : db.prepare('SELECT work_id, html FROM chapters WHERE html LIKE \'%<img%\' LIMIT 500').all();

const wanted = new Map();
for (const c of chapters) {
  for (const url of imageUrls(c.html)) {
    if (!wanted.has(url)) wanted.set(url, c.work_id);
  }
}

const already = db.prepare('SELECT 1 FROM images WHERE work_id = ? AND url = ? AND status = \'stored\'');
const save = db.prepare(`
  INSERT INTO images (work_id, url, sha256, mime, bytes, status, fetched_at)
  VALUES (?,?,?,?,?,?,datetime('now'))
  ON CONFLICT(work_id, url) DO UPDATE SET
    sha256=excluded.sha256, mime=excluded.mime, bytes=excluded.bytes,
    status=excluded.status, fetched_at=excluded.fetched_at`);

const limiter = createLimiter({ minInterval: 1500, jitter: 0.3 });
const { createHash } = await import('node:crypto');

let stored = 0; let dead = 0; let skipped = 0;
for (const [url, workId] of wanted) {
  if (already.get(workId, url)) { skipped++; continue; }
  try {
    const res = await limiter.run(() => fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36' },
      redirect: 'follow',
    }), { label: url.slice(0, 60) });

    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !type.startsWith('image/')) {
      // a host that has gone means the image is gone; record it so the next
      // run does not spend a request rediscovering that
      save.run(workId, url, null, null, null, 'dead');
      dead++;
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) { save.run(workId, url, null, type, null, 'dead'); dead++; continue; }
    const sha = createHash('sha256').update(buf).digest('hex');
    save.run(workId, url, sha, type, buf, 'stored');
    stored++;
  } catch {
    save.run(workId, url, null, null, null, 'dead');
    dead++;
  }
}

console.log(`images referenced ${wanted.size}`);
console.log(`  stored  ${stored}`);
console.log(`  dead    ${dead}`);
console.log(`  already ${skipped}`);
db.close();
