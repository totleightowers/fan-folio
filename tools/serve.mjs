/**
 * A local server for the archive, so the reader can be developed in a browser
 * before it is wrapped in an APK.
 *
 * Deliberately the same shape as the app's eventual native bridge: the page
 * asks for works, chapters and searches over a small JSON API and never
 * touches SQLite itself. Swapping this for the WebView bridge later changes
 * one file, not the app.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { renderChapter, sanitiseHtml } from '../app/core/render.js';
import { search } from '../app/core/discover.js';
import { buildWorksQuery, buildFacetQuery, buildColumnFacet, buildAuthorFacet, TAG_KINDS, STATES } from '../app/core/query.js';

const PORT = Number(process.env.PORT || 8080);
const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');

/* The shape the shared query modules expect: one function, SQL and arguments
   in, rows out. On the phone the same signature runs against Android's
   SQLite through the bridge, which is the point — neither side gets to hold
   its own copy of a query. */
const runner = (query, args = []) => db.prepare(query).all(...args);
const APP = new URL('../app/', import.meta.url).pathname;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

const Q = {
  count: db.prepare('SELECT count(*) n FROM works'),
  work: db.prepare('SELECT * FROM works WHERE work_id = ?'),
  chapters: db.prepare('SELECT number, title, words FROM chapters WHERE work_id = ? ORDER BY number'),
  chapter: db.prepare('SELECT number, title, html FROM chapters WHERE work_id = ? AND number = ?'),
  tags: db.prepare('SELECT kind, name FROM tags WHERE work_id = ? ORDER BY kind, name'),
  images: db.prepare("SELECT url, sha256 FROM images WHERE work_id = ? AND status = 'stored'"),
  image: db.prepare("SELECT mime, bytes FROM images WHERE sha256 = ? AND status = 'stored' LIMIT 1"),
  /* FTS4 has no bm25(); matchinfo travels back and is scored in JS so the
     dev server and the app rank identically. */
  search: db.prepare(`
    SELECT c.work_id, c.number, w.title, w.authors,
           snippet(chapter_fts, '<mark>', '</mark>', '…', -1, 18) AS snippet,
           matchinfo(chapter_fts, 'pcnalx') AS matchinfo
    FROM chapter_fts JOIN chapters c ON c.id = chapter_fts.docid
    JOIN works w ON w.work_id = c.work_id
    WHERE chapter_fts MATCH ? LIMIT ?`),
  searchMeta: db.prepare(`
    SELECT work_id, title, authors, summary FROM work_fts
    WHERE work_fts MATCH ? LIMIT ?`),
};

/**
 * What is worth tapping next.
 *
 * Counted against the filters already applied rather than the whole library,
 * so narrowing further can never land on an empty result — a filter panel that
 * offers a tag yielding nothing is worse than one that offers nothing at all.
 */
function facets(filters = {}) {
  const counts = {};
  for (const state of Object.keys(STATES)) {
    const q = buildWorksQuery({ ...filters, state });
    counts[state] = db.prepare(q.countSql).get(...q.args).n;
  }
  const tags = {};
  for (const kind of TAG_KINDS) {
    const q = buildFacetQuery(filters, kind, 40);
    tags[kind] = db.prepare(q.sql).all(...q.args);
  }
  /* Rating and language are counted from the work itself rather than from
     its tags. The panel draws those sections only when it has counts for
     them, and nothing was working them out — so they never appeared, and the
     filters behind them could not be reached. */
  for (const column of ['rating', 'language']) {
    const q = buildColumnFacet(filters, column);
    tags[column] = db.prepare(q.sql).all(...q.args);
  }
  try {
    const q = buildAuthorFacet(filters, 40);
    tags.author = db.prepare(q.sql).all(...q.args);
  } catch { tags.author = []; }
  return { counts, tags, fandoms: tags.fandom, languages: tags.language };
}

/** Filters as they arrive on the query string. Lists are tab-separated. */
function filtersFrom(params) {
  const filters = {
    state: params.get('state') || params.get('filter') || 'all',
    include: params.get('include') || '',
    exclude: params.get('exclude') || '',
    rating: params.get('rating') || '',
    author: params.get('author') || '',
    language: params.get('language') || '',
    wordsMin: params.get('wordsMin'), wordsMax: params.get('wordsMax'),
    chaptersMin: params.get('chaptersMin'), chaptersMax: params.get('chaptersMax'),
    sort: params.get('sort') || 'title',
  };
  const complete = params.get('complete');
  if (complete === '0' || complete === '1') filters.complete = complete;
  // a single tag, as the browse chips send it, is just one included tag
  const tag = params.get('tag');
  if (tag) filters.include = filters.include ? `${filters.include}\t${tag}` : tag;
  return filters;
}

/**
 * The home screen: a few short shelves rather than one long list.
 *
 * 1596 works sorted alphabetically is a filing cabinet, not a library. What a
 * reader actually wants on opening is the thing they were in the middle of,
 * then a few ways in — what they meant to read, what arrived recently, which
 * fandoms they have most of.
 */
function home() {
  const shelf = (where, order, limit = 12) => db.prepare(`
    SELECT w.work_id, w.title, w.authors, w.summary, w.words, w.chapter_count, w.complete, w.rating,
           w.rec,
           r.chapter AS at_chapter, r.chapters_read, r.marked_later,
           (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1) AS fandom
    FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
    WHERE ${where} ORDER BY ${order} LIMIT ?`).all(limit);

  const totals = db.prepare(`
    SELECT count(*) AS works, COALESCE(sum(words), 0) AS words,
           COALESCE(sum(chapter_count), 0) AS chapters FROM works`).get();
  const read = db.prepare(`
    SELECT COALESCE(sum(CASE WHEN r.chapters_read >= w.chapter_count THEN w.words ELSE 0 END), 0) AS words,
           count(CASE WHEN r.chapters_read >= w.chapter_count AND w.chapter_count > 0 THEN 1 END) AS finished
    FROM works w JOIN reading r ON r.work_id = w.work_id`).get();

  return {
    stats: {
      works: totals.works,
      words: totals.words,
      chapters: totals.chapters,
      finished: read.finished,
      wordsRead: read.words,
      later: db.prepare('SELECT count(*) n FROM reading WHERE marked_later = 1').get().n,
    },
    shelves: [
      { key: 'reading', title: 'Continue reading',
        works: shelf(
          /* Anything this app has had open, plus whatever an import said was
             already part-read, minus what is finished. Asking for chapter 2 or
             later — as this did — meant a work you were halfway through the
             first chapter of never reached the shelf, which is most of them
             and every one-chapter work there is. */
          '(r.opened_at IS NOT NULL OR COALESCE(r.chapters_read,0) > 0 '
          + 'OR COALESCE(r.chapter,0) > 1) '
          + 'AND COALESCE(r.chapters_read,0) < w.chapter_count',
          /* Most recently opened first, whichever shelf it was opened from. */
          'COALESCE(r.opened_at, r.updated_at) DESC') },
      { key: 'later', title: 'Marked for later',
        works: shelf('r.marked_later = 1', 'w.title COLLATE NOCASE') },
      { key: 'added', title: 'Recently added',
        works: shelf('1=1', 'COALESCE(w.downloaded_at, w.fetched_at) DESC') },
      { key: 'long', title: 'Settle in',
        works: shelf('w.complete = 1 AND COALESCE(r.chapters_read,0) = 0', 'w.words DESC') },
      { key: 'short', title: 'One sitting',
        works: shelf('w.complete = 1 AND w.words < 5000 AND COALESCE(r.chapters_read,0) = 0',
          'RANDOM()') },
    ].filter((s) => s.works.length),
    /*
     * Ways in, rather than one long list.
     *
     * Fic is navigated by fandom and pairing far more than by title, so the
     * tags people actually browse by get counted and offered. Ratings too —
     * "something explicit" and "something gen" are real moods.
     */
    browse: {
      fandom: topTags('fandom', 14),
      relationship: topTags('relationship', 14),
      character: topTags('character', 12),
      freeform: topTags('freeform', 14),
      rating: db.prepare(`
        SELECT rating AS name, count(*) AS n FROM works
        WHERE rating IS NOT NULL AND rating <> '' GROUP BY rating ORDER BY n DESC`).all(),
    },
  };
}

const topTags = (kind, limit) => db.prepare(`
  SELECT name, count(*) AS n FROM tags WHERE kind = ?
  GROUP BY name ORDER BY n DESC LIMIT ?`).all(kind, limit);

/** One work, chosen at random from those not yet started. */
function surprise() {
  const row = db.prepare(`
    SELECT w.work_id FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
    WHERE COALESCE(r.chapters_read, 0) = 0 ORDER BY RANDOM() LIMIT 1`).get();
  return { work_id: row?.work_id ?? null };
}

const json = (res, body, status = 200) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
};

async function serveStatic(res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(APP, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/api/works') {
      const filters = {
        ...filtersFrom(url.searchParams),
        limit: url.searchParams.get('limit') || 50,
        offset: url.searchParams.get('offset') || 0,
      };
      // a single tag, as the browse chips send it, is just one included tag
      const tag = url.searchParams.get('tag');
      if (tag) filters.include = filters.include ? `${filters.include}\t${tag}` : tag;
      const { sql, args, countSql } = buildWorksQuery(filters);
      return json(res, {
        total: db.prepare(countSql).get(...args).n,
        works: db.prepare(sql).all(...args),
      });
    }

    if (p === '/api/facets') return json(res, facets(filtersFrom(url.searchParams)));

    if (p === '/api/progress' && req.method === 'POST') {
      const workId = url.searchParams.get('workId');
      const chapter = Math.max(1, Number(url.searchParams.get('chapter') || 1));
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!workId) return json(res, { error: 'no work' }, 400);
      db.prepare(`
        INSERT INTO reading (work_id, chapter, offset, chapters_read, updated_at, opened_at)
        VALUES (?,?,?,?,datetime('now'),datetime('now'))
        ON CONFLICT(work_id) DO UPDATE SET
          chapter = excluded.chapter, offset = excluded.offset,
          chapters_read = max(COALESCE(reading.chapters_read, 0), excluded.chapters_read),
          updated_at = excluded.updated_at,
          opened_at = excluded.opened_at`).run(workId, chapter, offset, Math.max(0, chapter - 1));
      return json(res, { ok: true });
    }

    /* Opened, without saying where in it — a peek from a search result must
       not move the bookmark, but it is still reading. */
    if (p === '/api/opened' && req.method === 'POST') {
      const workId = url.searchParams.get('workId');
      if (!workId) return json(res, { error: 'no work' }, 400);
      db.prepare(`
        INSERT INTO reading (work_id, opened_at) VALUES (?, datetime('now'))
        ON CONFLICT(work_id) DO UPDATE SET opened_at = excluded.opened_at`).run(workId);
      return json(res, { ok: true });
    }

    if (p === '/api/add' && req.method === 'POST') {
      // the dev server does the whole job itself; the app fetches and parses in
      // the page and hands the result to its shell
      const { addWorkByLink } = await import('./lib/add.mjs');
      try {
        return json(res, await addWorkByLink(db, url.searchParams.get('url') ?? ''));
      } catch (e) {
        return json(res, { error: e.message }, 200);
      }
    }
    if (p === '/api/home') return json(res, home());
    if (p === '/api/surprise') return json(res, surprise());

    let m;
    if ((m = p.match(/^\/api\/works\/(\d+)$/))) {
      const work = Q.work.get(m[1]);
      if (!work) return json(res, { error: 'no such work' }, 404);
      const tags = {};
      for (const t of Q.tags.all(m[1])) (tags[t.kind] ??= []).push(t.name);
      let authors = [];
      try { authors = JSON.parse(work.authors || '[]'); } catch { authors = []; }
      const progress = db.prepare(
        'SELECT chapter, offset, chapters_read FROM reading WHERE work_id = ?').get(m[1]);
      return json(res, {
        ...work,
        at_chapter: progress?.chapter ?? null,
        chapters_read: progress?.chapters_read ?? 0,
        // AO3's own markup, generated from stored data so it works for every
        // work in the library rather than only the ones fetched from AO3
          // author-written HTML reaching innerHTML gets the same treatment as a
        // chapter body — there is no safer class of author markup
        end_notes_html: work.end_notes_html ? sanitiseHtml(work.end_notes_html) : null,
        tags,
        chapters: Q.chapters.all(m[1]),
        versions: db.prepare('SELECT count(*) AS n FROM chapter_versions WHERE work_id = ?').get(m[1])?.n ?? 0,
      });
    }

    if ((m = p.match(/^\/api\/works\/(\d+)\/chapters\/(\d+)$/))) {
      const row = Q.chapter.get(m[1], Number(m[2]));
      if (!row) return json(res, { error: 'no such chapter' }, 404);
      const work = Q.work.get(m[1]);
      // captured images replace their remote URLs; anything not captured keeps
      // its placeholder rather than reaching out to a third-party host
      const images = new Map(Q.images.all(m[1]).map((i) => [i.url, `/img/${i.sha256}`]));
      const rendered = renderChapter(row, { skinCss: work?.skin_css ?? null, images });
      return json(res, { number: row.number, title: row.title, ...rendered });
    }

    if ((m = p.match(/^\/img\/([0-9a-f]{64})$/))) {
      const img = Q.image.get(m[1]);
      if (!img) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {
        'Content-Type': img.mime || 'application/octet-stream',
        // content-addressed by hash, so it can never go stale
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return res.end(Buffer.from(img.bytes));
    }

    if (p === '/api/prefs') {
      // the theme imported from an Archive Reader backup, if there is one;
      // the app uses it only when the reader has not set their own
      try {
        const raw = await readFile(new URL('../data/prefs.json', import.meta.url).pathname, 'utf8');
        return json(res, JSON.parse(raw));
      } catch { return json(res, { prefs: null }); }
    }

    if ((m = p.match(/^\/api\/works\/(\d+)\/versions$/))) {
      return json(res, { versions: db.prepare(`
        SELECT id, number, title, words, reason, archived_at
          FROM chapter_versions WHERE work_id = ?
         ORDER BY archived_at DESC, number ASC`).all(m[1]) });
    }

    if ((m = p.match(/^\/api\/works\/(\d+)\/versions\/(\d+)$/))) {
      const row = db.prepare(`SELECT id, number, title, html, words, reason, archived_at
                                FROM chapter_versions WHERE work_id = ? AND id = ?`).get(m[1], Number(m[2]));
      if (!row) { res.writeHead(404); return res.end(); }
      const work = Q.work.get(m[1]);
      const images = new Map(Q.images.all(m[1]).map((i) => [i.url, `/img/${i.sha256}`]));
      return json(res, {
        ...row,
        workTitle: work?.title ?? '',
        ...renderChapter(row, { skinCss: work?.skin_css ?? null, images }),
      });
    }

    if (p === '/api/search') {
      const started = Date.now();
      try {
        const out = search(runner, url.searchParams.get('q'),
          url.searchParams.get('scope') || 'text', {
            limit: url.searchParams.get('limit'),
            workId: url.searchParams.get('workId'),
            filters: filtersFrom(url.searchParams),
          });
        return json(res, { ...out, ms: Date.now() - started });
      } catch (e) {
        /* FTS rejects a half-typed query — a lone quote, a stray operator.
           That is somebody typing, not a fault, so it reports rather than 500s. */
        return json(res, { error: e.message, hits: [], works: [], tags: [] });
      }
    }

    return serveStatic(res, p);
  } catch (e) {
    return json(res, { error: e.message }, 500);
  }
}).listen(PORT, async () => {
  // a pidfile, because pattern-killing a node process from a shell whose own
  // command line contains that pattern kills the shell instead
  try { await (await import('node:fs/promises')).writeFile('data/serve.pid', String(process.pid)); }
  catch { /* not fatal */ }
  const { n } = Q.count.get();
  console.log(`archive-reader dev server on http://localhost:${PORT}  (${n} works)`);
});
