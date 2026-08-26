/**
 * Everything already on the device, indexed — without asking AO3 anything.
 *
 * This index is what makes the sync cheap. A work listed on AO3 that is
 * already here, unchanged, costs nothing: the crawler reads this file instead
 * of fetching the work. Built from the EPUBs alone, so it can be rebuilt at
 * any time for free.
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEpub } from '../app/core/epub.js';

const dir = process.argv[2];
const out = process.argv[3] || 'data/library.json';
if (!dir) { console.error('usage: node tools/index-library.mjs <epub-dir> [out.json]'); process.exit(1); }

/**
 * Classes AO3 and the EPUB toolchain emit for every work. Anything outside
 * this set is the author's own — which means the work has a skin, which means
 * its stored copy cannot be rendered faithfully without one work-page fetch.
 * Flagging it here turns "refetch everything for skins" into "refetch ~14%".
 */
const HOUSE_CLASSES = [
  // Calibre numbers its generated classes without limit — calibre1, calibre47 —
  // so this has to be a pattern. Listing them out flagged every single work as
  // skinned, which would have meant refetching all 1596 instead of a fraction.
  /^calibre\d*$/,
  /^userstuff\d*$/,
  /^(message|byline|toc-heading|heading|endnote-link|tags|meta|preface|afterword)$/,
  /^(chapter|title|summary|notes|jump|landmark|p|li|bold|italics|small|indent)$/,
];

const isHouseClass = (c) => HOUSE_CLASSES.some((re) => re.test(c));

function customMarkup(chapters) {
  const html = chapters.map((c) => c.html).join('');
  if (/\sstyle\s*=/i.test(html)) return true;
  for (const m of html.matchAll(/class="([^"]+)"/gi))
    for (const c of m[1].split(/\s+/))
      if (c && !isHouseClass(c)) return true;
  return false;
}

const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.epub'));
const library = {};
const problems = [];
let skinned = 0;

for (const name of files) {
  try {
    const work = await parseEpub(new Uint8Array(await readFile(join(dir, name))));
    if (!work.workId) { problems.push({ file: name, why: 'no work id' }); continue; }
    const needsSkin = customMarkup(work.chapters);
    if (needsSkin) skinned++;
    library[work.workId] = {
      file: name,
      title: work.title,
      authors: work.authors,
      // the preface dates are the only "when was this last changed" the EPUB
      // has; compared against the listing's updated_at to decide on a refetch
      downloadedAt: work.downloadedAt ?? null,
      published: work.published?.slice(0, 10) ?? null,
      updated: work.updated ?? work.completed ?? null,
      complete: work.complete ?? null,
      words: work.words,
      chapters: work.chapters.length,
      chaptersPlanned: work.chaptersPlanned ?? null,
      needsSkin,
      images: work.chapters.reduce((n, c) => n + (c.html.match(/<img\b/gi) || []).length, 0),
    };
  } catch (e) {
    problems.push({ file: name, why: e.message });
  }
}

await mkdir('data', { recursive: true });
await writeFile(out, JSON.stringify({ builtAt: new Date().toISOString(), library, problems }, null, 1));

const ids = Object.keys(library);
console.log(`indexed      ${ids.length} works from ${files.length} files`);
console.log(`problems     ${problems.length}`);
console.log(`need a skin  ${skinned} (${(skinned / ids.length * 100).toFixed(1)}% — the only ones needing a work-page fetch)`);
console.log(`words        ${Object.values(library).reduce((n, w) => n + w.words, 0).toLocaleString()}`);
console.log(`written to   ${out}`);
