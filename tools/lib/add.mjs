/**
 * Adding one work by link, for the development server.
 *
 * The app does this in the page and hands the result to its shell. Here the
 * server does the whole thing, so the same button works while the reader is
 * being developed in a browser.
 */
import { createClient } from './client.mjs';
import { applyWithVersioning, chapterHash } from './versioning.mjs';
import { parseWorkPage } from '../../app/core/ao3/parse.js';
import { workPage, workIdFrom } from '../../app/core/ao3/urls.js';
import { htmlToText, countWords } from '../../app/core/epub.js';

const TAG_KINDS = [
  ['fandoms', 'fandom'], ['relationships', 'relationship'], ['characters', 'character'],
  ['freeform', 'freeform'], ['warnings', 'warning'], ['categories', 'category'],
  ['collections', 'collection'],
];

/**
 * @param client  an existing client, so a caller fetching many works paces them
 *                together. Creating one per work gives each its own limiter,
 *                and several thousand works are then requested back to back —
 *                which is the one thing the limiter exists to prevent. This
 *                parameter was lost once while resolving a merge, and the
 *                caller went on passing it to a function that ignored it.
 */
export async function addWorkByLink(db, input, { client: shared = null } = {}) {
  const workId = workIdFrom(input);
  if (!workId) throw new Error('That link does not name a work');

  const existing = db.prepare('SELECT title FROM works WHERE work_id = ?').get(workId);
  const client = shared ?? await createClient();
  const { status, body } = await client.get(workPage(workId), { label: `work ${workId}` });
  if (status !== 200) throw new Error(`The archive answered ${status}`);

  const w = parseWorkPage(body, { workId });
  if (!w.chapters.length) {
    throw new Error('No chapters found. The work may be restricted, deleted, or need a login.');
  }
  const meta = w.meta ?? {};

  const plan = await applyWithVersioning(db, workId, {
    chapters: w.chapters.map((c, i) => ({ ...c, number: i + 1, html: c.block ?? c.html })),
    skinCss: w.skinCss,
  });

  /* downloaded_at is when this copy was taken, and a fetch is exactly that.
     Only the EPUB import ever set it, so every work fetched from the archive
     looked to the sync planner as though it had never been downloaded — and
     sorted to the bottom of "recently added", which is where this was noticed.

     The reception counts have been parsed all along and thrown away. */
  db.prepare(`
    INSERT INTO works (work_id, title, authors, summary, rating, language, published, updated,
                       complete, words, chapter_count, chapters_planned, skin_css,
                       kudos, bookmark_count, hits,
                       source, fetched_at, downloaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ao3',datetime('now'),date('now'))
    ON CONFLICT(work_id) DO UPDATE SET
      title=excluded.title, authors=excluded.authors, summary=excluded.summary,
      rating=excluded.rating, language=excluded.language, published=excluded.published,
      updated=excluded.updated, complete=excluded.complete, words=excluded.words,
      chapter_count=excluded.chapter_count, chapters_planned=excluded.chapters_planned,
      skin_css=excluded.skin_css,
      kudos=excluded.kudos, bookmark_count=excluded.bookmark_count, hits=excluded.hits,
      source='ao3', fetched_at=datetime('now'), downloaded_at=date('now')`).run(
    workId, w.title, JSON.stringify(w.authors ?? []), w.summary,
    meta.rating ?? null, meta.language ?? null, meta.published ?? null, meta.updated ?? null,
    meta.complete ? 1 : 0, meta.words ?? null, w.chapters.length,
    meta.chaptersPlanned ?? null, w.skinCss ?? null,
    meta.kudos ?? null, meta.bookmarkCount ?? null, meta.hits ?? null);

  db.prepare('DELETE FROM tags WHERE work_id = ?').run(workId);
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (work_id, kind, name) VALUES (?,?,?)');
  const allTags = [];
  for (const [field, kind] of TAG_KINDS) {
    for (const name of meta[field] ?? []) { insertTag.run(workId, kind, name); allTags.push(name); }
  }

  // index rows are keyed on the chapter rowid, so they go before the rows do
  for (const row of db.prepare('SELECT id FROM chapters WHERE work_id = ?').all(workId)) {
    db.prepare('DELETE FROM chapter_fts WHERE rowid = ?').run(row.id);
  }
  db.prepare('DELETE FROM chapters WHERE work_id = ?').run(workId);

  const insertChapter = db.prepare(`
    INSERT INTO chapters (work_id, number, title, html, text, words, content_hash)
    VALUES (?,?,?,?,?,?,?)`);
  const indexChapter = db.prepare('INSERT INTO chapter_fts (rowid, text) VALUES (?,?)');
  for (const [i, c] of w.chapters.entries()) {
    const display = c.block ?? c.html;
    const text = htmlToText(c.html || display);
    const info = insertChapter.run(workId, i + 1, c.title, display, text,
      countWords(text), await chapterHash(display));
    indexChapter.run(info.lastInsertRowid, text);
  }

  db.prepare('DELETE FROM work_fts WHERE work_id = ?').run(workId);
  db.prepare('INSERT INTO work_fts (work_id, title, authors, summary, tags) VALUES (?,?,?,?,?)')
    .run(workId, w.title ?? '', (w.authors ?? []).join(', '), w.summary ?? '', allTags.join(', '));

  return {
    workId,
    title: w.title,
    chapters: w.chapters.length,
    words: meta.words ?? 0,
    added: !existing,
    archived: plan.changes.filter((c) => c.previous).length,
  };
}
