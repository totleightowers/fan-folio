/**
 * Fetch everything the walker found and we do not hold.
 *
 * The enumeration is finished; this is the long tail of actually collecting
 * it. Several thousand works at roughly two requests a minute is a run
 * measured in days, so the things that matter are that it is polite, that it
 * survives being interrupted, and that one bad work does not end it.
 *
 *   node tools/backfill.mjs            all four stages, in order
 *   node tools/backfill.mjs bookmarks  just one
 *
 * State lives in data/backfill.json and is written after every work, so
 * killing this at any moment loses at most the one in flight.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from './lib/client.mjs';
import { addWorkByLink } from './lib/add.mjs';
import { planSync, mergeListings } from '../app/core/sync/plan.js';

const STATE = 'data/backfill.json';
const STAGES = ['phantom', 'bookmarks', 'refetch', 'skins', 'history'];

const read = async (p, fallback = null) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
};

const bookmarks = await read('data/listing-bookmarks.json', null);
const history = await read('data/listing-history.json', null);

/* What is held comes from the database, not from data/library.json. That file
   was built from the EPUB import and knows nothing of anything fetched from
   the archive since, so planning against it would refetch works we already
   have. The one thing it does know is which works carry markup that wants a
   skin, so that hint alone is carried across. */
const indexed = (await read('data/library.json', { library: {} })).library ?? {};
const planningDb = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');
const library = {};
for (const r of planningDb.prepare(`
    SELECT work_id, downloaded_at, updated, published, chapter_count,
           skin_css IS NOT NULL AND skin_css <> '' AS has_skin
    FROM works`).all()) {
  const id = String(r.work_id);
  library[id] = {
    downloadedAt: r.downloaded_at,
    updated: r.updated,
    published: r.published,
    skinCss: r.has_skin ? 'held' : null,
    chapterCount: r.chapter_count,
    needsSkin: Boolean(indexed[id]?.needsSkin),
  };
}
planningDb.close();

const listed = mergeListings({ works: {}, bookmarks: bookmarks?.works, history: history?.works });
const plan = planSync(listed, library);

/* Bookmarks first: they are works somebody chose to keep. What is left of the
   fetch list is history — read once, never bookmarked — which is the bulk of
   the run and the least certain to be wanted. */
const inBookmarks = new Set(Object.keys(bookmarks?.works ?? {}).map(String));
/**
 * Works the EPUB import split into chapters that were never there.
 *
 * Calibre breaks a large document into several files, and the import counted
 * each file as a chapter — so a single-chapter work of fifty thousand words
 * arrived as forty-four, with a table of contents as its first chapter and an
 * empty fragment as its last.
 *
 * They are found by comparing what is held against the chapter counts already
 * in the listings, so identifying them costs nothing at all. Every one is an
 * EPUB import and every one holds more chapters than the archive says exist —
 * the archive is the only thing that knows the real shape, so they are asked
 * for again first.
 */
const phantom = [];
for (const [id, blurb] of listed) {
  const have = library[String(id)];
  if (!have || blurb?.chapters == null || have.chapterCount == null) continue;
  if (have.chapterCount > blurb.chapters) phantom.push(String(id));
}

const queues = {
  phantom,
  bookmarks: plan.actions.fetch.filter((id) => inBookmarks.has(String(id))),
  refetch: plan.actions.refetch,
  skins: plan.actions.skin,
  history: plan.actions.fetch.filter((id) => !inBookmarks.has(String(id))),
};

const only = process.argv.slice(2).filter((a) => STAGES.includes(a));
const running = only.length ? only : STAGES;

const state = await read(STATE, { done: [], failed: {}, startedAt: new Date().toISOString() });
const done = new Set(state.done);

const total = running.reduce((n, s) => n + queues[s].filter((id) => !done.has(String(id))).length, 0);
console.log(`backfill: ${running.join(' → ')}`);
for (const s of running) {
  const left = queues[s].filter((id) => !done.has(String(id))).length;
  console.log(`  ${s.padEnd(10)} ${String(queues[s].length).padStart(5)} listed, ${left} to do`);
}
console.log(`  ${'total'.padEnd(10)} ${String(total).padStart(5)} requests ≈ ${(total / 2 / 60).toFixed(1)} hours\n`);
if (!total) { console.log('nothing to do'); process.exit(0); }

const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');
/* One client for the whole run. Creating one per work gives each its own
   limiter, and the pacing that keeps this welcome disappears. */
const client = await createClient({ startDelay: Number(process.env.AO3_START_DELAY ?? 0) });

/* Written to one side and moved into place, because a plain write can be
   interrupted halfway and leave a file that parses as nothing. The state file
   exists to survive being killed; one that is corrupted by being killed is
   worse than none, since it looks like progress and is not. */
const save = async () => {
  state.done = [...done];
  state.updatedAt = new Date().toISOString();
  await writeFile(`${STATE}.tmp`, JSON.stringify(state, null, 2));
  await rename(`${STATE}.tmp`, STATE);
};

let ok = 0;
let failed = 0;
let n = 0;

for (const stage of running) {
  const queue = queues[stage].map(String).filter((id) => !done.has(id));
  if (!queue.length) continue;
  console.log(`\n── ${stage}: ${queue.length} works`);
  state.stage = stage;

  for (const workId of queue) {
    n += 1;
    try {
      const out = await addWorkByLink(db, workId, { client });
      done.add(workId);
      ok += 1;
      if (n % 10 === 0 || n === 1) {
        console.log(`  ${n}/${total}  ${workId} — ${out?.title ?? ''}`.slice(0, 100)
          + `  [${client.limiter.stats.requests} req, ${client.limiter.stats.throttled} throttled]`);
      }
    } catch (e) {
      /* Deleted, locked to members, orphaned: a listing outlives the work it
         points at, so some of these will never succeed. Recorded and stepped
         over rather than retried for ever. */
      failed += 1;
      done.add(workId);
      state.failed[workId] = String(e.message).slice(0, 120);
      console.error(`  ! ${workId}: ${state.failed[workId]}`);
    }
    await save();
  }
}

await save();
console.log(`\ndone: ${ok} fetched, ${failed} could not be`);
console.log(`requests ${client.limiter.stats.requests}, throttled ${client.limiter.stats.throttled}`);
