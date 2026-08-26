/**
 * Produce a single self-contained archive file for the app to import.
 *
 * The working database runs in WAL mode, so it is really several files and
 * copying only fanfolio.db silently drops whatever the write-ahead log still
 * holds. VACUUM INTO writes one consistent, compacted file — safe to hand to
 * the phone, and smaller than the original into the bargain.
 */
import { DatabaseSync } from 'node:sqlite';
import { rm, stat } from 'node:fs/promises';

const src = process.argv[2] || 'data/fanfolio.db';
const out = process.argv[3] || 'data/fanfolio-export.db';

await rm(out, { force: true });
const db = new DatabaseSync(src);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
console.log('checkpointed the write-ahead log');
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();

const [before, after] = await Promise.all([stat(src), stat(out)]);
const mb = (n) => (n / 1048576).toFixed(0);
console.log(`${mb(before.size)} MB → ${mb(after.size)} MB`);
console.log(`written to ${out}`);

const check = new DatabaseSync(out);
const q = (sql) => check.prepare(sql).get();
console.log(`works ${q('SELECT count(*) n FROM works').n}, ` +
  `chapters ${q('SELECT count(*) n FROM chapters').n}, ` +
  `images ${q('SELECT count(*) n FROM images').n}, ` +
  `versions ${q('SELECT count(*) n FROM chapter_versions').n}`);
console.log(`search index intact: ${q("SELECT count(*) n FROM chapter_fts WHERE chapter_fts MATCH 'petrichor'").n} hits for petrichor`);
check.close();
