/**
 * Load the EPUB library into the archive database. No network at all.
 *
 * This is the cheap half of the archive: 1596 works and 42 million words that
 * AO3 never has to be asked about. Everything the sync does later is a diff
 * against what this leaves behind.
 */
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEpub } from '../app/core/epub.js';
import { SCHEMA } from '../app/core/store/schema.js';

const dir = process.argv[2];
const dbPath = process.argv[3] || 'data/fanfolio.db';
if (!dir) { console.error('usage: node tools/ingest-epubs.mjs <epub-dir> [db]'); process.exit(1); }

await mkdir('data', { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(SCHEMA);

const insertWork = db.prepare(`
  INSERT INTO works (work_id, title, authors, summary, rating, language, published, updated,
                     downloaded_at, complete, words, chapter_count, chapters_planned,
                     end_notes_html, source, source_file, fetched_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'epub',?,datetime('now'))
  ON CONFLICT(work_id) DO UPDATE SET
    title=excluded.title, authors=excluded.authors, summary=excluded.summary,
    words=excluded.words, chapter_count=excluded.chapter_count,
    downloaded_at=excluded.downloaded_at, end_notes_html=excluded.end_notes_html,
    source_file=excluded.source_file`);
const insertTag = db.prepare('INSERT OR IGNORE INTO tags (work_id, kind, name) VALUES (?,?,?)');
/* An upsert updates and inserts but never removes. When a parser fix changed
   which documents count as chapters, the rows from the previous run stayed
   behind — a work reporting 31 chapters while holding 33. Clearing first makes
   a re-ingest describe the file as it is now, not as every previous run
   believed it to be. */
const clearChapters = db.prepare('DELETE FROM chapters WHERE work_id = ?');
const clearTags = db.prepare('DELETE FROM tags WHERE work_id = ?');
const insertChapter = db.prepare(`
  INSERT INTO chapters (work_id, number, title, html, text, words) VALUES (?,?,?,?,?,?)
  ON CONFLICT(work_id, number) DO UPDATE SET
    title=excluded.title, html=excluded.html, text=excluded.text, words=excluded.words`);
const insertWorkFts = db.prepare('INSERT INTO work_fts (work_id, title, authors, summary, tags) VALUES (?,?,?,?,?)');

const TAG_KINDS = [
  ['fandoms', 'fandom'], ['relationships', 'relationship'], ['characters', 'character'],
  ['freeform', 'freeform'], ['warnings', 'warning'], ['categories', 'category'],
];

/*
 * Works whose chapters came from AO3 are left alone.
 *
 * An AO3-sourced copy is strictly better than the EPUB one: it carries the
 * author's own markup, which is what a work skin styles. Re-running this
 * ingest used to clear and rewrite every chapter regardless, so rebuilding the
 * search index quietly replaced fetched chat markup with Calibre's flattened
 * version — and because the ingest does not go through the versioning path,
 * nothing was archived and nothing said so.
 */
const fromAo3 = new Set(
  db.prepare("SELECT work_id FROM works WHERE source = 'ao3'").all().map((r) => r.work_id)
);

const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.epub'));
let done = 0, failed = 0, chapters = 0, words = 0, skippedAo3 = 0;
const started = Date.now();

db.exec('BEGIN');
for (const name of files) {
  try {
    const w = await parseEpub(new Uint8Array(await readFile(join(dir, name))));
    if (!w.workId) { failed++; continue; }
    if (fromAo3.has(w.workId)) { skippedAo3++; continue; }

    insertWork.run(w.workId, w.title, JSON.stringify(w.authors ?? []), w.summary,
      w.rating ?? null, w.language ?? null, w.published?.slice(0, 10) ?? null,
      w.updated ?? w.completed ?? null, w.downloadedAt ?? null, w.complete ? 1 : 0, w.words,
      w.chapters.length, w.chaptersPlanned ?? null, w.endNotesHtml ?? null, name);

    clearChapters.run(w.workId);
    clearTags.run(w.workId);

    const allTags = [];
    for (const [field, kind] of TAG_KINDS)
      for (const t of w[field] ?? []) { insertTag.run(w.workId, kind, t); allTags.push(t); }

    // numbered by reading order, not by position in the EPUB spine: the spine
    // has gaps where the title page and end notes were removed
    for (const [i, c] of w.chapters.entries()) {
      insertChapter.run(w.workId, i + 1, c.title, c.html, c.text, c.words);
      chapters++;
    }
    insertWorkFts.run(w.workId, w.title ?? '', (w.authors ?? []).join(', '),
      w.summary ?? '', allTags.join(', '));

    words += w.words;
    if (++done % 200 === 0) {
      db.exec('COMMIT'); db.exec('BEGIN');   // keep the transaction from growing unbounded
      console.log(`  ${done}/${files.length} works, ${words.toLocaleString()} words`);
    }
  } catch (e) {
    failed++;
    if (failed <= 3) console.error(`  ! ${name}: ${e.message}`);
  }
}
db.exec('COMMIT');

console.log('building the full-text index…');
db.exec("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')");
db.exec('ANALYZE');

const took = ((Date.now() - started) / 1000).toFixed(0);
console.log(`\ningested ${done} works, ${chapters} chapters, ${words.toLocaleString()} words in ${took}s`);
console.log(`failed   ${failed}`);
console.log(`left as fetched from AO3: ${skippedAo3}`);
console.log(`database ${dbPath}`);
db.close();
