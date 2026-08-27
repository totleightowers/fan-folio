/**
 * Add a work to the archive from a link.
 *
 * Everything else in this project works from a library that already exists —
 * EPUBs on disk, bookmarks already made. This is the way in for a work you
 * have just been sent: paste the link, and it is fetched, stored and indexed
 * like any other, including its skin, its images and its metadata.
 *
 *   node tools/add-work.mjs https://archiveofourown.org/works/23690653
 *   node tools/add-work.mjs 23690653 40183902
 */
import { DatabaseSync } from 'node:sqlite';
import { createClient } from './lib/client.mjs';
import { applyWithVersioning, chapterHash } from './lib/versioning.mjs';
import { parseWorkPage } from '../app/core/ao3/parse.js';
import { workPage, workIdFrom } from '../app/core/ao3/urls.js';
import { htmlToText, countWords } from '../app/core/epub.js';
import { SCHEMA, ensureColumns } from '../app/core/store/schema.js';

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('usage: node tools/add-work.mjs <ao3 link or work id> [more…]');
  process.exit(1);
}

const ids = [];
for (const input of inputs) {
  const id = workIdFrom(input);
  if (id) ids.push(id);
  else console.error(`  ? no work id in "${input}" — skipped`);
}
if (!ids.length) process.exit(1);

const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');
db.exec(SCHEMA);
ensureColumns(db);   // an older library gains whatever columns it lacks

const upsertWork = db.prepare(`
  INSERT INTO works (work_id, title, authors, summary, rating, language, published, updated,
                     complete, words, chapter_count, chapters_planned, skin_css,
                     source, fetched_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ao3',datetime('now'))
  ON CONFLICT(work_id) DO UPDATE SET
    title=excluded.title, authors=excluded.authors, summary=excluded.summary,
    rating=excluded.rating, language=excluded.language, published=excluded.published,
    updated=excluded.updated, complete=excluded.complete, words=excluded.words,
    chapter_count=excluded.chapter_count, chapters_planned=excluded.chapters_planned,
    skin_css=excluded.skin_css, source='ao3', fetched_at=datetime('now')`);
const clearTags = db.prepare('DELETE FROM tags WHERE work_id = ?');
const insertTag = db.prepare('INSERT OR IGNORE INTO tags (work_id, kind, name) VALUES (?,?,?)');
const clearChapters = db.prepare('DELETE FROM chapters WHERE work_id = ?');
const insertChapter = db.prepare(`
  INSERT INTO chapters (work_id, number, title, html, text, words, content_hash)
  VALUES (?,?,?,?,?,?,?)`);
const insertWorkFts = db.prepare(
  'INSERT INTO work_fts (work_id, title, authors, summary, tags) VALUES (?,?,?,?,?)');
const clearWorkFts = db.prepare('DELETE FROM work_fts WHERE work_id = ?');

const TAG_KINDS = [
  ['fandoms', 'fandom'], ['relationships', 'relationship'], ['characters', 'character'],
  ['freeform', 'freeform'], ['warnings', 'warning'], ['categories', 'category'],
  ['collections', 'collection'],
];

const client = await createClient();
let added = 0; let updated = 0; let failed = 0;

for (const id of ids) {
  const existing = db.prepare('SELECT title FROM works WHERE work_id = ?').get(id);
  const { status, body } = await client.get(workPage(id), { label: `work ${id}` });
  if (status !== 200) {
    console.error(`  ! ${id}: AO3 answered ${status}`);
    failed++;
    continue;
  }

  const w = parseWorkPage(body, { workId: id });
  if (!w.chapters.length) {
    // a work can be locked to registered users, deleted, or a draft
    console.error(`  ! ${id}: no chapters found — the work may be restricted or gone`);
    failed++;
    continue;
  }
  const meta = w.meta ?? {};

  // archive anything about to be replaced before replacing it
  const plan = await applyWithVersioning(db, id, {
    chapters: w.chapters.map((c, i) => ({ ...c, number: i + 1, html: c.block ?? c.html })),
    skinCss: w.skinCss,
  });

  upsertWork.run(id, w.title, JSON.stringify(w.authors ?? []), w.summary,
    meta.rating ?? null, meta.language ?? null, meta.published ?? null,
    meta.updated ?? null, meta.complete ? 1 : 0, meta.words ?? null,
    w.chapters.length, meta.chaptersPlanned ?? null, w.skinCss ?? null);

  clearTags.run(id);
  const allTags = [];
  for (const [field, kind] of TAG_KINDS) {
    for (const name of meta[field] ?? []) { insertTag.run(id, kind, name); allTags.push(name); }
  }

  clearChapters.run(id);
  for (const [i, c] of w.chapters.entries()) {
    const display = c.block ?? c.html;
    const text = htmlToText(c.html || display);
    insertChapter.run(id, i + 1, c.title, display, text, countWords(text),
      await chapterHash(display));
  }

  clearWorkFts.run(id);
  insertWorkFts.run(id, w.title ?? '', (w.authors ?? []).join(', '),
    w.summary ?? '', allTags.join(', '));

  const archived = plan.changes.filter((c) => c.previous).length;
  console.log(`  ${existing ? '↻' : '+'} ${id}  ${w.title ?? '(untitled)'}`);
  console.log(`      ${w.chapters.length} chapters · ${(meta.words ?? 0).toLocaleString()} words`
    + `${w.skinCss ? ' · work skin' : ''}${w.images.length ? ` · ${w.images.length} images` : ''}`
    + `${archived ? ` · ${archived} earlier version(s) kept` : ''}`);
  if (existing) updated++; else added++;
}

// the search index must see the new text
db.exec("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')");

console.log(`\n${added} added, ${updated} updated, ${failed} failed`);
if (ids.some((id) => db.prepare('SELECT 1 FROM chapters WHERE work_id = ? AND html LIKE \'%<img%\'').get(id))) {
  console.log('Some works embed images — run tools/fetch-images.mjs to capture them.');
}
db.close();
