/**
 * Where the app's data comes from.
 *
 * One client, two backends. In the APK it runs the queries itself against
 * Android's SQLite through the native bridge; against the dev server it talks
 * HTTP. Everything above this file is identical either way, so the reader can
 * be developed in a browser and shipped without changing a line of it.
 */

import { renderChapter, sanitiseHtml } from './core/render.js';
import { workMetaHtml, workPrefaceHtml } from './core/ao3/markup.js';

const native = typeof window !== 'undefined' ? window.ArchiveNative : undefined;
export const isNative = Boolean(native);

/** One read-only query through the bridge. Throws what SQLite complained about. */
function sql(query, args = []) {
  const result = JSON.parse(native.query(query, JSON.stringify(args.map(String))));
  if (result.error) throw new Error(result.error);
  return result.rows;
}

const one = (query, args) => sql(query, args)[0] ?? null;
const parseAuthors = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

/* Only names from these maps ever reach the query; the reader's choice is
   looked up, never interpolated, so a crafted sort cannot become SQL. */
const SORTS = {
  title: 'w.title COLLATE NOCASE ASC',
  updated: 'COALESCE(w.updated, w.published) DESC',
  added: 'w.downloaded_at DESC',
  words: 'w.words DESC',
  shortest: 'w.words ASC',
  recent: 'r.last_read DESC',
};

const FILTERS = {
  all: '1=1',
  // a saved position counts as reading even when no chapter is marked read:
  // the imported backup recorded where you were far more often than what
  // you had finished, and the stricter test hid almost all of it
  reading: '(COALESCE(r.chapters_read, 0) > 0 OR COALESCE(r.chapter, 0) > 1) AND COALESCE(r.chapters_read, 0) < w.chapter_count',
  unread: 'COALESCE(r.chapters_read, 0) = 0 AND COALESCE(r.chapter, 0) <= 1',
  finished: 'r.chapters_read >= w.chapter_count AND w.chapter_count > 0',
  later: 'r.marked_later = 1',
  complete: 'w.complete = 1',
  wip: 'w.complete = 0',
  skinned: "w.skin_css IS NOT NULL AND w.skin_css <> ''",
};

const LOCAL = {
  '/api/works': ({ limit = 50, offset = 0, sort = 'title', filter = 'all', fandom = '', tag = '', rating = '' }) => {
    fandom = tag || fandom;
    const order = SORTS[sort] ?? SORTS.title;
    const where = [FILTERS[filter] ?? FILTERS.all];
    const args = [];
    if (fandom) {
      where.push("EXISTS (SELECT 1 FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' AND t.name = ?)");
      args.push(fandom);
    }
    if (rating) { where.push('w.rating = ?'); args.push(rating); }
    const from = `FROM works w LEFT JOIN reading r ON r.work_id = w.work_id WHERE ${where.join(' AND ')}`;
    return {
      total: sql(`SELECT count(*) AS n ${from}`, args)[0].n,
      works: sql(`SELECT w.work_id, w.title, w.authors, w.summary, w.words, w.chapter_count,
                         w.chapters_planned, w.complete, w.rating, w.published, w.updated,
                         w.downloaded_at,
                         w.skin_css IS NOT NULL AND w.skin_css <> '' AS has_skin,
                         r.chapter AS at_chapter, r.chapters_read, r.marked_later,
                         (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1) AS fandom,
                         (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'relationship' LIMIT 1) AS relationship
                  ${from} ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, limit, offset]),
    };
  },

  facets: () => {
    const counts = {};
    for (const [name, clause] of Object.entries(FILTERS)) {
      counts[name] = sql(
        `SELECT count(*) AS n FROM works w LEFT JOIN reading r ON r.work_id = w.work_id WHERE ${clause}`
      )[0].n;
    }
    return { counts, fandoms: sql(
      "SELECT name, count(*) AS n FROM tags WHERE kind = 'fandom' GROUP BY name ORDER BY n DESC LIMIT 25") };
  },

  work: (workId) => {
    const work = one('SELECT * FROM works WHERE work_id = ?', [workId]);
    if (!work) throw new Error('no such work');
    const tags = {};
    for (const t of sql('SELECT kind, name FROM tags WHERE work_id = ? ORDER BY kind, name', [workId])) {
      (tags[t.kind] ??= []).push(t.name);
    }
    return {
      ...work,
      tags,
      meta_html: workMetaHtml(work, tags),
      preface_html: workPrefaceHtml(work, parseAuthors(work.authors)),
      end_notes_html: work.end_notes_html ? sanitiseHtml(work.end_notes_html) : null,
      chapters: sql('SELECT number, title, words FROM chapters WHERE work_id = ? ORDER BY number', [workId]),
    };
  },

  chapter: (workId, number) => {
    const row = one('SELECT number, title, html FROM chapters WHERE work_id = ? AND number = ?',
      [workId, number]);
    if (!row) throw new Error('no such chapter');
    const work = one('SELECT skin_css FROM works WHERE work_id = ?', [workId]);
    const images = new Map(
      sql("SELECT url, sha256 FROM images WHERE work_id = ? AND status = 'stored'", [workId])
        .map((i) => [i.url, `/img/${i.sha256}`])
    );
    return { number: row.number, title: row.title,
      ...renderChapter(row, { skinCss: work?.skin_css ?? null, images }) };
  },

  search: (query, limit = 40) => {
    const started = Date.now();
    try {
      return {
        hits: sql(`SELECT c.work_id, c.number, w.title, w.authors,
                          snippet(chapter_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet
                   FROM chapter_fts JOIN chapters c ON c.id = chapter_fts.rowid
                   JOIN works w ON w.work_id = c.work_id
                   WHERE chapter_fts MATCH ? ORDER BY bm25(chapter_fts) LIMIT ?`, [query, limit]),
        works: [],
        ms: Date.now() - started,
      };
    } catch (e) {
      // a half-typed query is the reader typing, not a fault
      return { error: e.message, hits: [], works: [] };
    }
  },
};

export async function api(path) {
  if (!isNative) {
    const res = await fetch(path);
    return res.json();
  }

  const url = new URL(path, 'https://local/');
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);

  if (p === '/api/works') return LOCAL['/api/works']({
    ...q, limit: Number(q.limit || 50), offset: Number(q.offset || 0),
  });
  if (p === '/api/facets') return LOCAL.facets();

  let m;
  if ((m = p.match(/^\/api\/works\/(\d+)$/))) return LOCAL.work(m[1]);
  if ((m = p.match(/^\/api\/works\/(\d+)\/chapters\/(\d+)$/))) return LOCAL.chapter(m[1], Number(m[2]));
  if (p === '/api/search') return LOCAL.search((q.q ?? '').trim(), Number(q.limit || 40));

  // the imported Archive Reader theme is a development convenience only
  if (p === '/api/prefs') return { prefs: null };

  throw new Error(`no route for ${p}`);
}

/** What the shell can tell us about the archive it opened. */
export function nativeStatus() {
  if (!isNative) return { hasDatabase: true, fts5: true, dev: true };
  try { return JSON.parse(native.status()); } catch { return { hasDatabase: false, fts5: false }; }
}

export function importDatabase() {
  if (isNative) native.importDatabase();
}
