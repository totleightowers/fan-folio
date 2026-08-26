/**
 * What would a sync do right now? Costs nothing to ask.
 *
 * Reads the listing state the walker has built so far and the library index,
 * and reports the work AO3 would be asked for. Safe to run mid-enumeration —
 * the numbers simply firm up as more pages land.
 */
import { readFile } from 'node:fs/promises';
import { planSync, mergeListings, estimate } from '../app/core/sync/plan.js';

const read = async (p, fallback = null) => {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
};

const { library } = await read('data/library.json', { library: {} });
const bookmarks = await read('data/listing-bookmarks.json', null);
const history = await read('data/listing-history.json', null);

const listed = mergeListings({ works: {}, bookmarks: bookmarks?.works, history: history?.works });
const plan = planSync(listed, library);

const pageState = (s, name) => s
  ? `${name}: ${Object.keys(s.works).length} works from ${s.nextPage - 1}/${s.totalPages} pages`
    + (s.nextPage - 1 < s.totalPages ? '  (INCOMPLETE)' : '  (complete)')
  : `${name}: not started`;

console.log(pageState(bookmarks, 'bookmarks'));
console.log(pageState(history, 'history'));
console.log(`held locally: ${Object.keys(library).length} works\n`);

const c = plan.counts;
console.log('plan for what has been enumerated so far');
console.log(`  listed        ${c.listed}`);
console.log(`  already held  ${c.skip}   → 0 requests`);
console.log(`  fetch (new)   ${c.fetch}`);
console.log(`  refetch       ${c.refetch}  (AO3 says changed)`);
console.log(`  skin only     ${c.skin}`);
console.log(`  ─────────────`);
const e = estimate(c.requests);
console.log(`  requests      ${c.requests}  ≈ ${e.human} at ~2/min`);

const overlap = c.listed ? (c.skip / c.listed * 100).toFixed(0) : 0;
console.log(`\n${overlap}% of what has been listed is already on the device.`);

const sample = plan.actions.fetch.slice(0, 5);
if (sample.length) {
  console.log('\nexamples of works not yet held:');
  for (const id of sample) console.log(`  ${id}  ${listed.get(id)?.title ?? ''}`);
}
