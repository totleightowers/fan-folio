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
import { workMetaHtml, workPrefaceHtml } from '../app/core/ao3/markup.js';

const PORT = Number(process.env.PORT || 8080);
const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');
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
  search: db.prepare(`
    SELECT c.work_id, c.number, w.title, w.authors,
           snippet(chapter_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet,
           bm25(chapter_fts) AS rank
    FROM chapter_fts JOIN chapters c ON c.id = chapter_fts.rowid
    JOIN works w ON w.work_id = c.work_id
    WHERE chapter_fts MATCH ? ORDER BY rank LIMIT ?`),
  searchMeta: db.prepare(`
    SELECT work_id, title, authors, summary FROM work_fts
    WHERE work_fts MATCH ? LIMIT ?`),
};

/**
 * The library, sorted and filtered.
 *
 * Built as SQL text rather than a fixed prepared statement because the reader
 * chooses both. Only names from these two maps ever reach the query — the
 * parameters are looked up, never interpolated — so a crafted sort or filter
 * cannot become SQL.
 */
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

function worksQuery({ sort, filter, fandom, rating }) {
  const order = SORTS[sort] ?? SORTS.title;
  const where = [FILTERS[filter] ?? FILTERS.all];
  const args = [];
  if (fandom) {
    // "fandom" is really "any tag": the reader taps a pairing or a trope the
    // same way they tap a fandom, and one code path serves all of them
    where.push('EXISTS (SELECT 1 FROM tags t WHERE t.work_id = w.work_id AND t.name = ?)');
    args.push(fandom);
  }
  if (rating) { where.push('w.rating = ?'); args.push(rating); }
  const from = `FROM works w LEFT JOIN reading r ON r.work_id = w.work_id WHERE ${where.join(' AND ')}`;
  return {
    args,
    countSql: `SELECT count(*) n ${from}`,
    sql: `SELECT w.work_id, w.title, w.authors, w.summary, w.words, w.chapter_count,
                 w.chapters_planned, w.complete, w.rating, w.published, w.updated,
                 w.downloaded_at,
                 w.skin_css IS NOT NULL AND w.skin_css <> '' AS has_skin,
                 r.chapter AS at_chapter, r.chapters_read, r.marked_later,
                 (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1) AS fandom,
                 (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'relationship' LIMIT 1) AS relationship
          ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
  };
}

/** Counts for the filter chips, so the reader can see what is worth tapping. */
function facets() {
  const counts = {};
  for (const [name, clause] of Object.entries(FILTERS)) {
    counts[name] = db.prepare(
      `SELECT count(*) n FROM works w LEFT JOIN reading r ON r.work_id = w.work_id WHERE ${clause}`
    ).get().n;
  }
  const fandoms = db.prepare(`
    SELECT name, count(*) n FROM tags WHERE kind = 'fandom'
    GROUP BY name ORDER BY n DESC LIMIT 25`).all();
  return { counts, fandoms };
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
    SELECT w.work_id, w.title, w.authors, w.words, w.chapter_count, w.complete, w.rating,
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
        works: shelf('(COALESCE(r.chapters_read,0) > 0 OR COALESCE(r.chapter,0) > 1) '
          + 'AND COALESCE(r.chapters_read,0) < w.chapter_count', 'r.updated_at DESC') },
      { key: 'later', title: 'Marked for later',
        works: shelf('r.marked_later = 1', 'w.title COLLATE NOCASE') },
      { key: 'added', title: 'Recently added',
        works: shelf('1=1', 'w.downloaded_at DESC') },
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
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      const offset = Number(url.searchParams.get('offset') || 0);
      const { sql, args, countSql } = worksQuery({
        sort: url.searchParams.get('sort') || 'title',
        filter: url.searchParams.get('filter') || 'all',
        fandom: url.searchParams.get('tag') || url.searchParams.get('fandom') || '',
        rating: url.searchParams.get('rating') || '',
      });
      const total = db.prepare(countSql).get(...args).n;
      return json(res, { total, works: db.prepare(sql).all(...args, limit, offset) });
    }

    if (p === '/api/facets') return json(res, facets());
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
      return json(res, {
        ...work,
        // AO3's own markup, generated from stored data so it works for every
        // work in the library rather than only the ones fetched from AO3
        meta_html: workMetaHtml(work, tags),
        preface_html: workPrefaceHtml(work, authors),
        // author-written HTML reaching innerHTML gets the same treatment as a
        // chapter body — there is no safer class of author markup
        end_notes_html: work.end_notes_html ? sanitiseHtml(work.end_notes_html) : null,
        tags,
        chapters: Q.chapters.all(m[1]),
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

    if (p === '/api/search') {
      const q = url.searchParams.get('q')?.trim();
      if (!q) return json(res, { hits: [], works: [] });
      const limit = Math.min(Number(url.searchParams.get('limit') || 40), 100);
      const started = Date.now();
      let hits = [];
      let works = [];
      try {
        hits = Q.search.all(q, limit);
        works = Q.searchMeta.all(q, 12);
      } catch (e) {
        // FTS5 rejects malformed queries (a lone quote, a stray operator).
        // That is a user typing, not a server fault, so it reports rather than 500s.
        return json(res, { error: e.message, hits: [], works: [] }, 200);
      }
      return json(res, { hits, works, ms: Date.now() - started });
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
