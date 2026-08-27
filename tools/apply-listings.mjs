/**
 * Fold what the listings learned into the works themselves.
 *
 * The walker records what is bookmarked, what is in the reading history, when
 * each was bookmarked and which are starred as recommendations. Until it is
 * written onto the works, none of it can be filtered on — the listing state is
 * a crawl artefact, not something the reader can use.
 *
 * Safe to re-run: it sets flags from the current listings and nothing else.
 */
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../app/core/store/schema.js';

const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');
db.exec(SCHEMA);
for (const column of ['rec INTEGER DEFAULT 0']) {
  try { db.exec(`ALTER TABLE works ADD COLUMN ${column}`); } catch { /* already there */ }
}

const load = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf8')).works ?? {}; } catch { return {}; }
};

const bookmarks = await load('data/listing-bookmarks.json');
const history = await load('data/listing-history.json');

const setBookmark = db.prepare(
  'UPDATE works SET in_bookmarks = 1, rec = ?, bookmarked_at = ? WHERE work_id = ?');
const setHistory = db.prepare(
  'UPDATE works SET in_history = 1, last_visited = ?, visits = ? WHERE work_id = ?');

db.exec('BEGIN');
db.exec('UPDATE works SET in_bookmarks = 0, in_history = 0, rec = 0');

let bookmarked = 0; let recs = 0; let seen = 0; let missing = 0;
for (const [workId, blurb] of Object.entries(bookmarks)) {
  const changed = setBookmark.run(blurb.bookmarkRec ? 1 : 0, blurb.bookmarkedAt ?? null, workId);
  if (changed.changes) { bookmarked++; if (blurb.bookmarkRec) recs++; } else missing++;
}
for (const [workId, blurb] of Object.entries(history)) {
  const changed = setHistory.run(blurb.lastVisited ?? null, blurb.visits ?? null, workId);
  if (changed.changes) seen++;
}
db.exec('COMMIT');

console.log(`bookmarks listed   ${Object.keys(bookmarks).length}`);
console.log(`  matched a work   ${bookmarked}`);
console.log(`  of those, recs   ${recs}`);
console.log(`  not held yet     ${missing}`);
console.log(`history listed     ${Object.keys(history).length}`);
console.log(`  matched a work   ${seen}`);
db.close();
