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
import { search } from './core/discover.js';
import { buildWorksQuery, buildFacetQuery, TAG_KINDS, STATES } from './core/query.js';
import { parseWorkPage } from './core/ao3/parse.js';
import { workPage, workIdFrom } from './core/ao3/urls.js';
import { htmlToText, countWords } from './core/epub.js';

const native = typeof window !== 'undefined' ? window.ArchiveNative : undefined;
export const isNative = Boolean(native);

/**
 * One read-only query through the bridge.
 *
 * Android binds selection arguments as text — its rawQuery takes String[] and
 * nothing else — and SQLite rejects text where it needs an integer, so a
 * bound `LIMIT ?` fails with a datatype mismatch. Counts are therefore
 * validated as integers and written into the SQL by `lim()` below, never
 * bound. Everything a reader can influence still goes through binding.
 */
function sql(query, args = []) {
  const raw = native.query(query, JSON.stringify(args.map(String)));
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error(`bridge returned unparseable JSON: ${String(raw).slice(0, 120)}`); }
  if (result.error) throw new Error(`${result.error} — in: ${query.trim().slice(0, 90)}…`);
  return result.rows;
}

/** A count safe to inline: an integer, clamped, never reader-supplied text. */
const lim = (n, fallback = 50, max = 500) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 0 ? Math.min(v, max) : fallback;
};

const one = (query, args) => sql(query, args)[0] ?? null;
const parseAuthors = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

const LOCAL = {
  '/api/works': (params) => {
    const filters = { ...params };
    if (params.tag) {
      filters.include = filters.include ? `${filters.include}\t${params.tag}` : params.tag;
    }
    const q = buildWorksQuery(filters);
    return {
      total: sql(q.countSql, q.args)[0].n,
      works: sql(q.sql, q.args),
    };
  },

  /**
   * The home screen, computed locally.
   *
   * This existed only on the dev server, so the APK asked for a route that was
   * not there and the whole home view failed with "no route for /api/home".
   * Anything the server can answer, the bridge has to answer too — that is the
   * entire point of the seam.
   */
  home: () => {
    const shelf = (where, order, limit = 12) => sql(`
      SELECT w.work_id, w.title, w.authors, w.words, w.chapter_count, w.complete, w.rating,
             w.rec,
             r.chapter AS at_chapter, r.chapters_read, r.marked_later,
             (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1) AS fandom
      FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
      WHERE ${where} ORDER BY ${order} LIMIT ${lim(limit, 12)}`);

    const totals = sql('SELECT count(*) AS works, COALESCE(sum(words),0) AS words FROM works')[0];
    const read = sql(`
      SELECT COALESCE(sum(CASE WHEN r.chapters_read >= w.chapter_count THEN w.words ELSE 0 END),0) AS words,
             count(CASE WHEN r.chapters_read >= w.chapter_count AND w.chapter_count > 0 THEN 1 END) AS finished
      FROM works w JOIN reading r ON r.work_id = w.work_id`)[0];

    const top = (kind, limit) => sql(
      `SELECT name, count(*) AS n FROM tags WHERE kind = ? GROUP BY name ORDER BY n DESC LIMIT ${lim(limit, 12)}`,
      [kind]);

    return {
      stats: {
        works: totals.works, words: totals.words,
        finished: read.finished, wordsRead: read.words,
        later: sql('SELECT count(*) AS n FROM reading WHERE marked_later = 1')[0].n,
      },
      shelves: [
        { key: 'reading', title: 'Continue reading',
          works: shelf('(COALESCE(r.chapters_read,0) > 0 OR COALESCE(r.chapter,0) > 1) '
            + 'AND COALESCE(r.chapters_read,0) < w.chapter_count', 'r.updated_at DESC') },
        { key: 'later', title: 'Marked for later',
          works: shelf('r.marked_later = 1', 'w.title COLLATE NOCASE') },
        { key: 'added', title: 'Recently added', works: shelf('1=1', 'w.downloaded_at DESC') },
        { key: 'long', title: 'Settle in',
          works: shelf('w.complete = 1 AND COALESCE(r.chapters_read,0) = 0', 'w.words DESC') },
        { key: 'short', title: 'One sitting',
          works: shelf('w.complete = 1 AND w.words < 5000 AND COALESCE(r.chapters_read,0) = 0', 'RANDOM()') },
      ].filter((sh) => sh.works.length),
      browse: {
        fandom: top('fandom', 14), relationship: top('relationship', 14),
        character: top('character', 12), freeform: top('freeform', 14),
        rating: sql(`SELECT rating AS name, count(*) AS n FROM works
                     WHERE rating IS NOT NULL AND rating <> '' GROUP BY rating ORDER BY n DESC`),
      },
    };
  },

  surprise: () => ({
    work_id: sql(`SELECT w.work_id FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
                  WHERE COALESCE(r.chapters_read,0) = 0 ORDER BY RANDOM() LIMIT 1`)[0]?.work_id ?? null,
  }),

  facets: (filters = {}) => {
    const counts = {};
    for (const state of Object.keys(STATES)) {
      const q = buildWorksQuery({ ...filters, state });
      counts[state] = sql(q.countSql, q.args)[0].n;
    }
    const tags = {};
    for (const kind of TAG_KINDS) {
      const q = buildFacetQuery(filters, kind, 40);
      tags[kind] = sql(q.sql, q.args);
    }
    return {
      counts, tags, fandoms: tags.fandom,
      languages: sql(`SELECT language AS name, count(*) AS n FROM works
                      WHERE language IS NOT NULL AND language <> '' GROUP BY language ORDER BY n DESC`),
    };
  },

  work: (workId) => {
    const work = one('SELECT * FROM works WHERE work_id = ?', [workId]);
    if (!work) throw new Error('no such work');
    const tags = {};
    for (const t of sql('SELECT kind, name FROM tags WHERE work_id = ? ORDER BY kind, name', [workId])) {
      (tags[t.kind] ??= []).push(t.name);
    }
    const progress = one(
      'SELECT chapter, offset, chapters_read FROM reading WHERE work_id = ?', [workId]);
    return {
      ...work,
      at_chapter: progress?.chapter ?? null,
      chapters_read: progress?.chapters_read ?? 0,
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

  search: (query, scope, options) => {
    const started = Date.now();
    try {
      return { ...search(sql, query, scope, options), ms: Date.now() - started };
    } catch (e) {
      // a half-typed query is the reader typing, not a fault
      return { error: e.message, hits: [], works: [], tags: [] };
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

  if (p === '/api/works') return LOCAL['/api/works'](q);
  if (p === '/api/facets') return LOCAL.facets(q);
  if (p === '/api/home') return LOCAL.home();
  if (p === '/api/surprise') return LOCAL.surprise();

  let m;
  if ((m = p.match(/^\/api\/works\/(\d+)$/))) return LOCAL.work(m[1]);
  if ((m = p.match(/^\/api\/works\/(\d+)\/chapters\/(\d+)$/))) return LOCAL.chapter(m[1], Number(m[2]));
  if (p === '/api/search') {
    return LOCAL.search(q.q ?? '', q.scope || 'text',
      { limit: q.limit, workId: q.workId, filters: q });
  }

  // the imported Archive Reader theme is a development convenience only
  if (p === '/api/prefs') return { prefs: null };

  throw new Error(`no route for ${p}`);
}

/**
 * What a fetched work looks like on its way into storage.
 *
 * Built here rather than in the shell so the shape is decided once, in the
 * same code that parsed it — the native side writes what it is given and makes
 * no decisions of its own about what a work is.
 */
function payloadFor(workId, w) {
  const meta = w.meta ?? {};
  const tags = {};
  for (const [field, kind] of [
    ['fandoms', 'fandom'], ['relationships', 'relationship'], ['characters', 'character'],
    ['freeform', 'freeform'], ['warnings', 'warning'], ['categories', 'category'],
    ['collections', 'collection'],
  ]) {
    if (meta[field]?.length) tags[kind] = meta[field];
  }

  return {
    workId,
    title: w.title ?? null,
    authors: JSON.stringify(w.authors ?? []),
    summary: w.summary ?? null,
    rating: meta.rating ?? null,
    language: meta.language ?? null,
    published: meta.published ?? null,
    updated: meta.updated ?? null,
    complete: Boolean(meta.complete),
    words: meta.words ?? 0,
    chaptersPlanned: meta.chaptersPlanned ?? null,
    skin_css: w.skinCss ?? null,
    tags,
    chapters: w.chapters.map((c) => {
      const display = c.block ?? c.html ?? '';
      const text = htmlToText(c.html || display);
      return { title: c.title ?? null, html: display, text, words: countWords(text) };
    }),
  };
}

/**
 * Add a work from a link.
 *
 * In the app the page fetches through the shell's proxy — AO3 sends no CORS
 * headers — parses with the same code the tooling uses, and hands the result
 * to the shell to store. Against the dev server the whole job happens there.
 */
export async function addWork(input) {
  const workId = workIdFrom(input);
  if (!workId) throw new Error('That link does not name a work');

  if (!isNative) {
    const res = await fetch(`/api/add?url=${encodeURIComponent(input)}`, { method: 'POST' });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    return out;
  }

  const res = await fetch(`/__net/?url=${encodeURIComponent(workPage(workId))}`);
  const body = await res.text();
  if (!res.ok) {
    /* A 500 here is the shell's proxy failing, not the archive refusing — the
       two are worth telling apart, and the reason is in the body. Saying only
       "answered 500" sends you looking at the wrong end of the problem. */
    const detail = body.trim().slice(0, 200);
    if (res.status === 500) throw new Error(detail || 'The app could not reach the archive');
    if (res.status === 404) throw new Error('That work does not exist, or has been deleted');
    if (res.status === 403 || res.status === 401) {
      throw new Error('That work is restricted — sign in to the archive first');
    }
    throw new Error(`The archive answered ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const w = parseWorkPage(body, { workId });
  if (!w.chapters.length) {
    // locked to registered users, deleted, or a draft — all look the same here
    throw new Error('No chapters found. The work may be restricted, deleted, or need a login.');
  }

  const out = JSON.parse(native.saveWork(JSON.stringify(payloadFor(workId, w))));
  if (out.error) throw new Error(out.error);
  return { workId, title: w.title, chapters: w.chapters.length, words: w.meta?.words ?? 0 };
}

/** What the shell can tell us about the archive it opened. */
export function nativeStatus() {
  if (!isNative) return { hasDatabase: true, search: true, dev: true };
  try { return JSON.parse(native.status()); } catch { return { hasDatabase: false, search: false }; }
}

/**
 * Write the library out to a file the reader chooses.
 *
 * Only the shell can do this: the page has no way to reach the filesystem, and
 * the database is the app's entire contents rather than something it can
 * reassemble. Outside the APK there is nothing to export — the dev server
 * already reads a file sitting on disk.
 */
export function exportDatabase() {
  if (!isNative) return false;
  native.exportDatabase();
  return true;
}

/** Bytes on disk, so the page can say what a backup will cost. */
export function databaseSize() {
  if (!isNative) return 0;
  try { return Number(native.databaseSize()) || 0; } catch { return 0; }
}

/**
 * A tick at the moment something commits.
 *
 * The shell routes this through the system's own haptic setting, so a phone
 * with haptics turned off gets nothing without the app having to ask.
 */
export function haptic(kind = 'tick') {
  if (!isNative) return;
  try { native.haptic(kind); } catch { /* a device without an actuator */ }
}

export function importDatabase() {
  if (isNative) native.importDatabase();
}

/** A link the shell was opened with, if it arrived before the page was ready. */
export function pendingLink() {
  if (!isNative) return '';
  try { return native.takePendingLink() || ''; } catch { return ''; }
}

/**
 * Record where the reader has got to.
 *
 * One store, not two: everything that shows progress reads the same table.
 * Failures are swallowed — losing a scroll position is not worth interrupting
 * somebody's reading with an error.
 */
export async function saveProgress(workId, chapter, offset) {
  try {
    if (isNative) {
      native.saveProgress(String(workId), Number(chapter), Number(offset) || 0);
      return;
    }
    await fetch(`/api/progress?workId=${encodeURIComponent(workId)}`
      + `&chapter=${Number(chapter)}&offset=${Number(offset) || 0}`, { method: 'POST' });
  } catch { /* the reader carries on regardless */ }
}

/* --------------------------------------------------------------- signing in */

/**
 * Signing in happens on the archive's own page, in a window of its own.
 *
 * Nothing here ever sees a password: the shell opens the real login form over
 * HTTPS with no bridge attached, and what comes back is a session cookie the
 * proxy attaches to archive requests. It expires by itself and is forgotten on
 * sign out.
 */
export function signIn() {
  if (!isNative) throw new Error('Signing in is only available in the app');
  native.signIn();
}

export function signOut() {
  if (isNative) native.signOut();
}

export function signedIn() {
  if (!isNative) return false;
  try { return Boolean(native.signedIn()); } catch { return false; }
}
