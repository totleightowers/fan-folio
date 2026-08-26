/**
 * How big is the job? Two requests, nothing fetched, nothing written.
 *
 * Worth doing before any sync: it turns "this might take a while" into a
 * number, and it proves the session, the parsers and the pacing all work
 * together before a long run depends on them.
 */
import { createClient } from './lib/client.mjs';
import { parseListing } from '../app/core/ao3/parse.js';
import { readings, bookmarks, PER_PAGE } from '../app/core/ao3/urls.js';

const user = process.argv[2];
if (!user) { console.error('usage: node tools/recon.mjs <ao3-username>'); process.exit(1); }

const client = await createClient();

async function probe(name, url) {
  const { status, body } = await client.get(url, { label: name });
  const { works, pagination } = parseListing(body);
  console.log(`\n${name}`);
  console.log(`  status        ${status}`);
  console.log(`  works on p1   ${works.length}`);
  console.log(`  pages         ${pagination.total}`);
  const est = pagination.total * PER_PAGE;
  console.log(`  ~works total  ${est.toLocaleString()} (upper bound)`);
  console.log(`  listing cost  ${pagination.total} requests ≈ ${Math.ceil(pagination.total * 5 / 60)} min at 12/min`);
  if (works[0]) {
    const w = works[0];
    console.log(`  newest        ${w.title} — ${w.authors.join(', ') || 'anon'}`);
    console.log(`                id=${w.workId} updated=${w.updatedAt} words=${w.words}`);
    if ('lastVisited' in w) console.log(`                last visited ${w.lastVisited}, ${w.visits}x`);
  }
  return { works, pagination };
}

const b = await probe('bookmarks', bookmarks(user, 1));
const h = await probe('history', readings(user, 1));

console.log('\n--- parser check on live data ---');
for (const [name, r] of [['bookmarks', b], ['history', h]]) {
  const w = r.works;
  const missing = (f) => w.filter((x) => x[f] === null || x[f] === undefined).length;
  console.log(`${name}: ids ${w.filter((x) => x.workId).length}/${w.length}, ` +
    `titles missing ${missing('title')}, updatedAt missing ${missing('updatedAt')}, ` +
    `visits present ${w.filter((x) => 'visits' in x).length}`);
}
