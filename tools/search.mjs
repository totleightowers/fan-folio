/**
 * Full-text search over the archive. Also the proof that the index works.
 *
 * FTS5 query syntax passes straight through, so phrases ("coffee shop"),
 * prefixes (thunder*), NEAR() and boolean operators all work as AO3's own
 * search never has.
 */
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');

const HIT = db.prepare(`
  SELECT w.title, w.authors, c.number,
         snippet(chapter_fts, 0, '«', '»', '…', 12) AS snip,
         bm25(chapter_fts) AS rank
  FROM chapter_fts
  JOIN chapters c ON c.id = chapter_fts.rowid
  JOIN works   w ON w.work_id = c.work_id
  WHERE chapter_fts MATCH ?
  ORDER BY rank
  LIMIT ?`);
const COUNT = db.prepare('SELECT count(*) n FROM chapter_fts WHERE chapter_fts MATCH ?');

export function search(query, limit = 5) {
  const started = Date.now();
  const rows = HIT.all(query, limit);
  const total = COUNT.get(query).n;
  return { rows, total, ms: Date.now() - started };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const queries = process.argv.slice(2);
  for (const q of queries.length ? queries : ['"coffee shop"', 'thunderstorm', 'petrichor', 'NEAR(soulmate mark, 10)']) {
    const { rows, total, ms } = search(q);
    console.log(`\n▸ ${q}  — ${total} chapters, ${ms}ms`);
    for (const r of rows) {
      const who = (JSON.parse(r.authors || '[]')[0]) ?? 'anon';
      console.log(`   ${r.title} (ch ${r.number}) — ${who}`);
      console.log(`     ${r.snip.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }
}
