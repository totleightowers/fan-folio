/**
 * What is actually inside these works, structurally?
 *
 * Rendering and asset-capture decisions should follow the corpus, not the
 * format's theoretical capabilities. Scans raw spine markup — no text
 * extraction — so it stays quick over the whole library.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readZip } from '../app/core/zip.js';

const dir = process.argv[2];
const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.epub'));

const worksWith = new Map();
const totals = new Map();
const imgHosts = new Map();
const classes = new Map();
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

for (const name of files) {
  let zip;
  try { zip = await readZip(new Uint8Array(await readFile(join(dir, name)))); }
  catch { continue; }

  const html = [...zip.entries()]
    .filter(([k]) => /\.x?html$/i.test(k))
    .map(([, v]) => new TextDecoder().decode(v))
    .join('\n');

  const hit = {};
  const feature = (key, re) => {
    const n = (html.match(re) || []).length;
    if (n) { hit[key] = true; bump(totals, key, n); }
  };
  feature('img', /<img\b/gi);
  feature('table', /<table\b/gi);
  feature('blockquote', /<blockquote\b/gi);
  feature('inline style=', /\sstyle\s*=/gi);
  feature('<style> block', /<style\b/gi);
  feature('centred/aligned', /align\s*=|text-align/gi);
  feature('external link', /<a\b[^>]*href="https?:\/\//gi);
  feature('heading in body', /<h[1-6]\b/gi);
  feature('pre/code', /<(pre|code)\b/gi);
  for (const k of Object.keys(hit)) bump(worksWith, k);

  for (const m of html.matchAll(/<img\b[^>]*src="([^"]+)"/gi)) {
    const src = m[1];
    if (/^data:/i.test(src)) { bump(imgHosts, '(inline data: uri)'); continue; }
    if (!/^https?:/i.test(src)) { bump(imgHosts, '(packaged in epub)'); continue; }
    try { bump(imgHosts, new URL(src).hostname.replace(/^www\./, '')); } catch { bump(imgHosts, '(unparseable)'); }
  }
  for (const m of html.matchAll(/class="([^"]+)"/gi))
    for (const c of m[1].split(/\s+/)) if (!/^calibre/.test(c) && c) bump(classes, c);
}

const table = (m, label) => {
  console.log(`\n${label}`);
  for (const [k, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 18))
    console.log(`  ${String(n).padStart(7)}  ${k}`);
};
console.log('works scanned', files.length);
table(worksWith, 'works containing each feature (of ' + files.length + '):');
table(totals, 'total occurrences:');
table(imgHosts, 'image sources:');
table(classes, 'non-calibre classes (work-skin candidates):');
