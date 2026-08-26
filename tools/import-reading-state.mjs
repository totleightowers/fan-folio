/**
 * Carry reading progress across from an Archive Reader backup.
 *
 * The theme makes the app look familiar; this makes it *be* familiar — every
 * work you are part-way through opens where you left it, and everything you
 * marked for later is still marked. None of it costs an AO3 request.
 *
 * Field numbers rather than names, because Hive stores neither: the adapter's
 * field order lives in the app's compiled Dart. They were read off the data —
 * field 0 is the work id (it matches the record key), 1 the chapter count,
 * 2 the per-chapter scroll offsets, 3 the per-chapter read markers.
 */
import { readFile, mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { readZip } from '../app/core/zip.js';
import { readHive } from './hive.mjs';
import { SCHEMA } from '../app/core/store/schema.js';

const src = process.argv[2];
const dbPath = process.argv[3] || 'data/fanfolio.db';
if (!src) { console.error('usage: node tools/import-reading-state.mjs <backup.ao3> [db]'); process.exit(1); }

await mkdir('data', { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(SCHEMA);

const zip = await readZip(new Uint8Array(await readFile(src)));
const box = (name) => {
  const raw = zip.get(name);
  return raw ? readHive(raw) : new Map();
};

const positions = box('box_work_positions.hive');
const toRead = box('box_works_toread.hive');

const upsert = db.prepare(`
  INSERT INTO reading (work_id, chapter, offset, chapters_read, chapter_count,
                       marked_later, imported_from, updated_at)
  VALUES (?,?,?,?,?,?,?,datetime('now'))
  ON CONFLICT(work_id) DO UPDATE SET
    chapter=excluded.chapter, offset=excluded.offset,
    chapters_read=excluded.chapters_read, chapter_count=excluded.chapter_count,
    marked_later=max(reading.marked_later, excluded.marked_later)`);

db.exec('BEGIN');

let withProgress = 0;
for (const [key, rec] of positions) {
  if (!rec || typeof rec !== 'object') continue;
  const offsets = Array.isArray(rec[2]) ? rec[2] : [];
  const marks = Array.isArray(rec[3]) ? rec[3] : [];
  const count = Number(rec[1]) || Math.max(offsets.length, marks.length, 1);

  // the furthest chapter showing any sign of having been opened
  let furthest = 0;
  for (let i = 0; i < Math.max(offsets.length, marks.length); i++) {
    if (Math.abs(offsets[i] ?? 0) > 1e-9 || (marks[i] ?? 0) !== 0) furthest = i;
  }
  const chaptersRead = marks.filter((m) => Number(m) > 0).length;
  if (furthest > 0 || chaptersRead > 0) withProgress++;

  upsert.run(String(key), furthest + 1, Number(offsets[furthest] ?? 0),
    chaptersRead, count, 0, 'archive-reader-backup');
}

/*
 * Marking for later must not disturb a reading position.
 *
 * Sharing the positions upsert looked harmless and was not: its
 * ON CONFLICT clause sets every column from the incoming row, so a work that
 * is both part-read and marked for later had its chapter and offset nulled.
 * That silently destroyed roughly three hundred reading positions — the exact
 * data this import exists to preserve.
 */
const markLater = db.prepare(`
  INSERT INTO reading (work_id, marked_later, imported_from, updated_at)
  VALUES (?,1,?,datetime('now'))
  ON CONFLICT(work_id) DO UPDATE SET marked_later = 1`);

let later = 0;
for (const [key, rec] of toRead) {
  if (!rec) continue;
  markLater.run(String(key), 'archive-reader-backup');
  later++;
}

db.exec('COMMIT');

const q = (sql) => db.prepare(sql).get();
console.log(`positions imported : ${positions.size}`);
console.log(`  with real progress: ${withProgress}`);
console.log(`marked for later   : ${later}`);
const held = q(`SELECT count(*) n FROM reading r JOIN works w ON w.work_id = r.work_id`).n;
const total = q('SELECT count(*) n FROM reading').n;
console.log(`\nreading rows       : ${total}`);
console.log(`  matching a work already held: ${held}`);
console.log(`  not yet held (candidates to fetch): ${total - held}`);
db.close();
