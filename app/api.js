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
import { parseWorkPage, parseListing } from './core/ao3/parse.js';
import { workPage, linkTarget, chapterUrl, seriesPage, ORIGIN } from './core/ao3/urls.js';
import { parseForm, csrfToken, encodeForm } from './core/ao3/forms.js';
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
      versions: one('SELECT count(*) AS n FROM chapter_versions WHERE work_id = ?', [workId])?.n ?? 0,
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

  /**
   * Earlier copies of a work's chapters.
   *
   * The archive is a living thing: authors revise, rewrite and sometimes
   * delete. Every replaced chapter has been kept since versioning went in, and
   * until now there was no way to look at one — the whole point of keeping
   * them is being able to read what you read the first time.
   *
   * The text itself is left behind here; a list of what exists should not
   * carry a megabyte of prose.
   */
  versions: (workId) => sql(`
    SELECT id, number, title, words, reason, archived_at
      FROM chapter_versions WHERE work_id = ?
     ORDER BY archived_at DESC, number ASC`, [workId]),

  version: (workId, id) => {
    const row = one(`SELECT id, number, title, html, words, reason, archived_at
                       FROM chapter_versions WHERE work_id = ? AND id = ?`, [workId, id]);
    if (!row) throw new Error('no such version');
    const work = one('SELECT title, skin_css FROM works WHERE work_id = ?', [workId]);
    const images = new Map(
      sql("SELECT url, sha256 FROM images WHERE work_id = ? AND status = 'stored'", [workId])
        .map((i) => [i.url, `/img/${i.sha256}`])
    );
    return {
      ...row,
      workTitle: work?.title ?? '',
      ...renderChapter(row, { skinCss: work?.skin_css ?? null, images }),
    };
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
  if ((m = p.match(/^\/api\/works\/(\d+)\/versions$/))) return { versions: LOCAL.versions(m[1]) };
  if ((m = p.match(/^\/api\/works\/(\d+)\/versions\/(\d+)$/))) return LOCAL.version(m[1], Number(m[2]));
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
/**
 * Add whatever a link points at.
 *
 * The archive names works in more shapes than one, and they are not
 * interchangeable. A chapter id is not a work id — fetching /works/<chapter
 * id> would quietly return a different story rather than fail — and a series
 * names many works at once. Where the link does not carry a work id, the
 * archive is asked rather than guessed at.
 */
export async function addWork(input) {
  const target = linkTarget(input);

  if (target.kind === 'external') {
    throw new Error('That is a link to a work hosted elsewhere; the archive only holds its details');
  }
  if (target.kind === 'unknown') {
    throw new Error('That link does not name a work');
  }

  if (!isNative) {
    const res = await fetch(`/api/add?url=${encodeURIComponent(input)}`, { method: 'POST' });
    const out = await res.json();
    if (out.error) throw new Error(out.error);
    return out;
  }

  if (target.kind === 'series') return addSeries(target.seriesId);

  const workId = target.kind === 'chapter'
    ? await workIdForChapter(target.chapterId)
    : target.workId;

  return fetchAndSave(workId);
}

/**
 * Which work owns this chapter.
 *
 * Only the archive knows. A chapter page always links back to the work it
 * belongs to, so the id is read from the page rather than from the URL that
 * was followed to reach it — the shell's proxy reports its own address, not
 * the one the archive redirected to.
 */
async function workIdForChapter(chapterId) {
  const res = await fetch(`/__net/?url=${encodeURIComponent(chapterUrl(chapterId))}`);
  const body = await res.text();
  if (!res.ok) throw new Error(`The archive answered ${res.status} for that chapter`);
  const found = body.match(/\/works\/(\d+)/);
  if (!found) throw new Error('That chapter does not say which work it belongs to');
  return found[1];
}

/**
 * Every work in a series, one at a time.
 *
 * Deliberately sequential: a series can be long, and the archive is quick to
 * throttle anything that asks for a lot at once. One failure does not abandon
 * the rest — a series with a single restricted work in it should still bring
 * back the others.
 */
async function addSeries(seriesId) {
  const res = await fetch(`/__net/?url=${encodeURIComponent(seriesPage(seriesId))}`);
  const body = await res.text();
  if (!res.ok) throw new Error(`The archive answered ${res.status} for that series`);

  const ids = [...new Set(parseListing(body).works.map((w) => w.workId).filter(Boolean))];
  if (!ids.length) throw new Error('That series has no works we can see');

  const added = [];
  const failed = [];
  for (const id of ids) {
    try {
      added.push(await fetchAndSave(id));
    } catch (e) {
      failed.push({ workId: id, reason: e.message });
    }
  }
  return {
    kind: 'series',
    seriesId,
    added: added.length,
    failed,
    works: added,
    title: `${added.length} work${added.length === 1 ? '' : 's'} from the series`,
  };
}

/** One work: fetch the whole thing, parse it, hand it to the shell to store. */
async function fetchAndSave(workId) {
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

/**
 * Open a page on the archive in a browser, deliberately not in here.
 *
 * The app claims archive links now, so an ordinary link would be offered
 * straight back to it and the reader would arrive where they already were.
 * The shell excludes this app from the chooser.
 */
export function openOnArchive(path) {
  if (!isNative) { window.open(new URL(path, ORIGIN).toString(), '_blank', 'noopener'); return; }
  native.openInBrowser(path);
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

/* ------------------------------------------------------ acting on the archive
 *
 * Kudos, bookmarks and comments are writes performed as the signed-in reader,
 * and they go through a bridge method rather than the usual proxy: Android
 * never hands a request body to shouldInterceptRequest, so the proxy the rest
 * of the app uses can only ever perform a GET.
 *
 * None of the field names are hardcoded. Each of these reads the form the
 * archive itself served and submits it with the reader's values substituted,
 * so a renamed field stays working and a missing form fails loudly instead of
 * posting something malformed.
 */

/** GET a page through the ordinary proxy and hand back its HTML. */
async function page(url) {
  const res = await fetch(`/__net/?url=${encodeURIComponent(url)}`);
  const body = await res.text();
  if (!res.ok) throw new Error(`The archive answered ${res.status}`);
  return body;
}

/**
 * POST a form, as the signed-in reader.
 *
 * A path, never a URL: the shell holds the host as a constant, so nothing
 * crossing the bridge can decide where a signed-in write is sent. A form
 * action is usually a path already; one written absolutely is reduced to its
 * path here, and anything pointing off the archive has nowhere to go.
 */
async function submit(action, fields, refererPath) {
  const raw = native.archivePost(pathOnArchive(action), encodeForm(fields), refererPath);
  const out = JSON.parse(raw);
  if (out.error) throw new Error(out.error);
  return out;
}

/** The path a form action names, refusing anything that leaves the archive. */
function pathOnArchive(action) {
  const url = new URL(action, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error('That form points somewhere other than the archive');
  return `${url.pathname}${url.search}`;
}

/** The first of several shapes the form might be identified by. */
function findForm(html, matchers) {
  for (const m of matchers) {
    const form = parseForm(html, m);
    if (form) return form;
  }
  return null;
}

function requireSignedIn() {
  if (!isNative) throw new Error('Acting on the archive needs the app');
  if (!signedIn()) throw new Error('Sign in to the archive first');
}

/**
 * Leave kudos.
 *
 * The archive accepts them once per work per person and answers a second
 * attempt with an error rather than a success, which is why this is recorded
 * locally: there is no way to ask afterwards whether they were left.
 */
export async function leaveKudos(workId) {
  requireSignedIn();
  const referer = `/works/${Number(workId)}`;
  const html = await page(workPage(workId));
  const form = findForm(html, ['id="new_kudo"', 'action="/kudos"', 'id="kudo_submit"']);
  if (!form) throw new Error('The archive did not offer a kudos form on that work');

  const res = await submit(form.action, form.fields, referer);
  /* The archive says so in the page it returns rather than in the status: a
     duplicate is an error, and an error that says "already left kudos" is the
     one outcome worth treating as success. */
  const already = /already left kudos/i.test(res.body ?? '');
  if (!already && res.status >= 400) throw new Error(refusal(res, 'The archive refused the kudos'));

  native.markWork(String(workId), 'kudos_given', true);
  return { workId, already };
}

/**
 * Bookmark a work.
 *
 * The form lives on its own page rather than on the work, and carries the
 * reader's pseud and their defaults — which is exactly why it is read rather
 * than reconstructed. An unticked box is left out, because submitting one is
 * how a private bookmark quietly becomes a public one.
 */
export async function bookmarkWork(workId, { notes = '', tags = '', isPrivate = false, rec = false } = {}) {
  requireSignedIn();
  const referer = `/works/${Number(workId)}`;
  /* view_adult, for the same reason workPage sends it: without it a Mature
     work answers with the consent interstitial instead of the page asked for,
     and that interstitial carries a form of its own. */
  const html = await page(`${ORIGIN}/works/${Number(workId)}/bookmarks/new?view_adult=true`);
  const form = findForm(html, ['id="bookmark-form"', 'id="new_bookmark"',
    `action="/works/${Number(workId)}/bookmarks"`]);
  if (!form) throw new Error('The archive did not offer a bookmark form for that work');

  const fields = { ...form.fields };
  const set = (suffix, value) => {
    const key = Object.keys(fields).find((k) => k.endsWith(suffix))
      ?? `bookmark[${suffix.replace(/^\[|\]$/g, '')}]`;
    if (value === false) delete fields[key];
    else fields[key] = value === true ? '1' : value;
  };
  if (notes) set('[bookmarker_notes]', notes);
  if (tags) set('[tag_string]', tags);
  set('[private]', isPrivate);
  set('[rec]', rec);

  const res = await submit(form.action, fields, referer);
  if (res.status >= 400) throw new Error(refusal(res, 'The archive refused the bookmark'));

  native.markWork(String(workId), 'in_bookmarks', true);
  if (rec) native.markWork(String(workId), 'rec', true);
  return { workId, rec };
}

/**
 * Leave a comment.
 *
 * Refuses an empty one before anything is sent: an empty comment is a form
 * error round-trip that tells the reader nothing they did not already know.
 */
export async function commentOnWork(workId, text) {
  requireSignedIn();
  const content = String(text ?? '').trim();
  if (!content) throw new Error('There is nothing to say yet');

  const referer = `/works/${Number(workId)}`;
  const html = await page(workPage(workId));
  const form = findForm(html, ['id="new_comment"',
    `action="/works/${Number(workId)}/comments"`]);
  if (!form) throw new Error('That work does not take comments');

  const fields = { ...form.fields };
  const key = Object.keys(fields).find((k) => k.endsWith('[comment_content]'))
    ?? 'comment[comment_content]';
  fields[key] = content;

  const res = await submit(form.action, fields, referer);
  if (res.status >= 400) throw new Error(refusal(res, 'The archive refused the comment'));
  return { workId };
}
