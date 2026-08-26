/**
 * Walk a bookmarks or history listing and record every work in it.
 *
 * Enumeration is the one cost that cannot be avoided: AO3 offers no way to ask
 * "what is in my history" except twenty at a time. So this is written to be
 * paid once — state is flushed after every page, and a re-run picks up at the
 * page it stopped on rather than starting again.
 *
 * It fetches no works. It only learns which works exist and when they changed,
 * which is what makes the expensive phase selective.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createClient } from './lib/client.mjs';
import { parseListing } from '../app/core/ao3/parse.js';
import { readings, bookmarks } from '../app/core/ao3/urls.js';

const [user, kind = 'history', maxPagesArg] = process.argv.slice(2);
if (!user) { console.error('usage: node tools/walk-listings.mjs <user> [history|bookmarks] [maxPages]'); process.exit(1); }
const maxPages = maxPagesArg ? Number(maxPagesArg) : Infinity;

const urlFor = kind === 'bookmarks' ? bookmarks : readings;
const statePath = `data/listing-${kind}.json`;

async function load() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); }
  catch { return { kind, user, nextPage: 1, totalPages: null, works: {}, startedAt: new Date().toISOString() }; }
}

const state = await load();
if (state.user !== user) throw new Error(`${statePath} holds ${state.user}, not ${user}`);
await mkdir('data', { recursive: true });

const client = await createClient({ startDelay: Number(process.env.AO3_START_DELAY ?? 0) });
console.log(`${kind}: resuming at page ${state.nextPage}${state.totalPages ? ` of ${state.totalPages}` : ''}`);

let pagesThisRun = 0;
while (pagesThisRun < maxPages) {
  const page = state.nextPage;
  if (state.totalPages && page > state.totalPages) break;

  const { body } = await client.get(urlFor(user, page), { label: `${kind} p${page}` });
  const { works, pagination } = parseListing(body);
  state.totalPages ??= pagination.total;

  if (!works.length && page > 1) { console.log(`page ${page} is empty — stopping`); break; }

  for (const w of works) {
    const prev = state.works[w.workId];
    // history lists a work once per visit position; keep the richest record
    state.works[w.workId] = prev ? { ...prev, ...w } : w;
  }

  state.nextPage = page + 1;
  state.updatedAt = new Date().toISOString();
  await writeFile(statePath, JSON.stringify(state));
  pagesThisRun++;

  const known = Object.keys(state.works).length;
  if (page % 10 === 0 || page === state.totalPages)
    console.log(`  page ${page}/${state.totalPages} — ${known} works, ${client.limiter.stats.requests} requests, ${client.limiter.stats.throttled} throttled`);
  if (page >= state.totalPages) break;
}

const works = Object.values(state.works);
console.log(`\n${kind}: ${works.length} works over ${state.nextPage - 1} pages`);
console.log(`requests ${client.limiter.stats.requests}, retries ${client.limiter.stats.retries}, throttled ${client.limiter.stats.throttled}`);
console.log(`state in ${statePath}`);
