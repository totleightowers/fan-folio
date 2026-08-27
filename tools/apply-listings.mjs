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
import { SCHEMA, ensureColumns } from '../app/core/store/schema.js';

const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');
db.exec(SCHEMA);
ensureColumns(db);   // an older library gains whatever columns it lacks

const load = async (path) => {
  try { return JSON.parse(await readFile(path, 'utf8')).works ?? {}; } catch { return {}; }
};

const bookmarks = await load('data/listing-bookmarks.json');
const history = await load('data/listing-history.json');

const setBookmark = db.prepare(
  'UPDATE works SET in_bookmarks = 1, rec = ?, bookmarked_at = ? WHERE work_id = ?');
const setHistory = db.prepare(
  'UPDATE works SET in_history = 1, last_visited = ?, visits = ? WHERE work_id = ?');

/* Every blurb carries what the archive reported about a work's reception, and
   we already have thousands of them on disk. Reading them back costs nothing,
   where asking the archive again would be several thousand requests for
   numbers we were already told.

   COALESCE keeps whatever is already there when a blurb is silent, so a listing
   without a count cannot erase one we have. */
const setCounts = db.prepare(`UPDATE works SET
    kudos = COALESCE(?, kudos),
    bookmark_count = COALESCE(?, bookmark_count),
    hits = COALESCE(?, hits)
  WHERE work_id = ?`);

/* A copy fetched from the archive is a copy taken, so downloaded_at belongs
   on it — but nothing set it until late, and a long-running backfill holds the
   old code in memory for as long as it runs. Repaired from fetched_at, which
   records the same moment. */
db.exec('BEGIN');
db.exec('UPDATE works SET in_bookmarks = 0, in_history = 0, rec = 0');

let bookmarked = 0; let recs = 0; let seen = 0; let missing = 0;
for (const [workId, blurb] of Object.entries(bookmarks)) {
  const changed = setBookmark.run(blurb.bookmarkRec ? 1 : 0, blurb.bookmarkedAt ?? null, workId);
  if (changed.changes) { bookmarked++; if (blurb.bookmarkRec) recs++; } else missing++;
}
const repaired = db.prepare(`UPDATE works SET downloaded_at = date(fetched_at)
   WHERE downloaded_at IS NULL AND fetched_at IS NOT NULL`).run().changes;

let counted = 0;
for (const [workId, blurb] of Object.entries({ ...history, ...bookmarks })) {
  const changed = setCounts.run(
    blurb.kudos ?? null, blurb.bookmarkCount ?? null, blurb.hits ?? null, workId);
  if (changed.changes) counted++;
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
console.log(`download dates    ${repaired} repaired from fetched_at`);
console.log(`counts written    ${counted}  (kudos, bookmarks, hits — from blurbs already on disk)`);
db.close();
