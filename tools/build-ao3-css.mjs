/**
 * Build AO3's own work styling into a stylesheet confined to the reading pane.
 *
 * These files are AO3's, taken from the otwarchive source rather than scraped
 * from the site. They are what makes a work look like it does on AO3 —
 * paragraph rhythm, blockquotes, lists, tables, headings — and a work skin is
 * written by its author assuming they are present.
 *
 * Everything is scoped under .ao3page — the container the detail and reader
 * views share — so AO3's element rules style the work and nothing else. The
 * work skin's own #workskin scope sits inside it, exactly as on AO3. Colour is
 * deliberately left to the reader's theme.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { scopeCss } from '../app/core/render.js';

const FILES = [
  '02-elements.css',      // AO3's reset and base element rhythm
  '10-types-groups.css',  // .module, .group — the chapter's own containers
  '12-group-meta.css',    // the work meta block
  '14-group-preface.css', // title, byline, summary, notes
  '21-userstuff.css',     // the work body itself
];
const parts = [];

for (const name of FILES) {
  const css = await readFile(new URL(`../app/vendor/ao3/${name}`, import.meta.url), 'utf8');
  parts.push(`/* --- ${name} (otwarchive) --- */\n${scopeCss(css, '.ao3page')}`);
}

/*
 * AO3's palette is dropped on purpose. The reader has chosen a background and
 * a text colour, and a work should honour that the way the site does under a
 * dark site skin — while a work skin's own colours (chat bubbles and the like)
 * still come through, because those are part of the work.
 */
const stripped = parts.join('\n\n')
  .replace(/^\s*(color|background|background-color)\s*:[^;}]+;?/gim, '')
  .replace(/\{\s*\}/g, '{}');

await writeFile(new URL('../app/ao3-work.css', import.meta.url), `/*
 * AO3 work styling, from otwarchive, scoped to the reading pane.
 * Regenerate with: node tools/build-ao3-css.mjs
 */
${stripped}
`);
console.log(`built app/ao3-work.css from ${FILES.length} otwarchive stylesheets`);
