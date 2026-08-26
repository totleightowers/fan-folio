/**
 * Read every EPUB in a folder and report what the parser actually recovers.
 * Not a test — a survey, so the schema is built from what the files contain
 * rather than from what the format allows.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEpub } from '../app/core/epub.js';
import { readZip } from '../app/core/zip.js';

const dir = process.argv[2];
const limit = Number(process.argv[3] || Infinity);

const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.epub')).slice(0, limit);
const stats = { ok: 0, failed: 0, noWorkId: 0, words: 0, dupes: 0 };
const fieldCount = new Map();
const metaNames = new Map();
const errors = [];
const seen = new Map();

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

for (const name of files) {
  try {
    const bytes = new Uint8Array(await readFile(join(dir, name)));
    const work = await parseEpub(bytes);
    stats.ok++;
    stats.words += work.words;
    if (!work.workId) { stats.noWorkId++; errors.push(`no work id: ${name}`); }
    else if (seen.has(work.workId)) { stats.dupes++; }
    else seen.set(work.workId, name);

    for (const [k, v] of Object.entries(work)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      bump(fieldCount, k);
    }
    // surface any custom <meta name="..."> the script wrote
    const zip = await readZip(bytes);
    const opfName = [...zip.keys()].find((k) => k.endsWith('.opf'));
    if (opfName) {
      const opf = new TextDecoder().decode(zip.get(opfName));
      for (const m of opf.matchAll(/<meta\s+[^>]*name\s*=\s*"([^"]+)"/gi)) bump(metaNames, m[1]);
    }
  } catch (e) {
    stats.failed++;
    errors.push(`${name}: ${e.message}`);
  }
}

console.log('files      ', files.length);
console.log('parsed ok  ', stats.ok);
console.log('failed     ', stats.failed);
console.log('no work id ', stats.noWorkId);
console.log('duplicates ', stats.dupes, '(same work id, more than one file)');
console.log('total words', stats.words.toLocaleString());
console.log('\nfield coverage (of parsed):');
for (const [k, n] of [...fieldCount].sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(n).padStart(5)}  ${k}`);
console.log('\ncustom opf <meta name=…>:');
for (const [k, n] of [...metaNames].sort((a, b) => b[1] - a[1]).slice(0, 25))
  console.log(`  ${String(n).padStart(5)}  ${k}`);
if (errors.length) console.log('\nfirst problems:\n' + errors.slice(0, 12).join('\n'));
