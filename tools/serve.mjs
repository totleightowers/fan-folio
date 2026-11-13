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
import { RECORD_VISIT } from '../app/core/store/visits.js';
import { INDEX_FIRST, deleteStatements, TOMBSTONE } from '../app/core/store/delete.js';
import { isHidden, worksByPattern } from '../app/core/store/blocked.js';
import { createReadRoutes } from '../app/core/routes.js';
import { CHAPTERS } from '../app/core/query.js';

import { RESTART_READING } from '../app/core/store/reading.js';
import { ensureColumns } from '../app/core/store/schema.js';

const PORT = Number(process.env.PORT || 8080);
const db = new DatabaseSync(process.env.FANFOLIO_DB || 'data/fanfolio.db');

ensureColumns(db);

/* The shape the shared query modules expect: one function, SQL and arguments
   in, rows out. On the phone the same signature runs against Android's
   SQLite through the bridge, which is the point — neither side gets to hold
   its own copy of a query. */
/* Arguments are bound as text, because that is all Android's rawQuery can
   bind: a query that only works with a real integer bound fails here too,
   rather than on the phone. */
const runner = (query, args = []) => db.prepare(query).all(...args.map(String));
const routes = createReadRoutes(runner);
const APP = new URL('../app/', import.meta.url).pathname;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

const Q = {
  count: db.prepare('SELECT count(*) n FROM works'),
  image: db.prepare("SELECT mime, bytes FROM images WHERE sha256 = ? AND status = 'stored' LIMIT 1"),
};

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
    /* Every read is the app's own route, run against this database: the
       dev server holds no second copy of a query to drift from the first. */
    if (req.method === 'GET' || req.method === 'HEAD') {
      let answer;
      try {
        answer = routes.read(url.pathname + url.search);
      } catch (e) {
        if (/^no such /.test(e.message)) return json(res, { error: e.message }, 404);
        throw e;
      }
      if (answer !== undefined) return json(res, answer);
    }

    if (p === '/api/restart' && req.method === 'POST') {
      const workId = url.searchParams.get('workId');
      if (!workId) return json(res, { error: 'no work' }, 400);
      db.prepare(RESTART_READING).run(workId);
      return json(res, { ok: true });
    }

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

    /*
     * Remove a work, everything it owns, and remember that it went.
     *
     * The index goes first and by hand: chapter_fts is external-content FTS4
     * keyed on the chapter's rowid, so deleting the chapters first leaves
     * index rows pointing at chapters that are not there. The tables and
     * their order come from core/store/delete.js, which the shell mirrors —
     * two implementations of "everything a work owns" that drift is a
     * library that grows a little every time somebody tidies it.
     */
    if (p === '/api/delete' && req.method === 'POST') {
      const workId = url.searchParams.get('workId');
      if (!workId) return json(res, { error: 'no work' }, 400);
      const title = db.prepare('SELECT title FROM works WHERE work_id = ?').get(workId)?.title ?? null;
      db.exec('BEGIN');
      try {
        for (const row of db.prepare('SELECT id FROM chapters WHERE work_id = ?').all(workId)) {
          db.prepare(`DELETE FROM ${INDEX_FIRST} WHERE rowid = ?`).run(row.id);
        }
        for (const sql of deleteStatements()) db.prepare(sql).run(workId);
        db.prepare(TOMBSTONE).run(workId, title);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        return json(res, { error: e.message }, 500);
      }
      return json(res, { ok: true });
    }

    /*
     * Never fetch them again, and stop showing what is solely theirs.
     *
     * Only the works this one name could affect are restated, matched the way
     * the author filter matches — the name quoted as it appears inside the
     * JSON array, so blocking "Anna" does not touch "Annabel".
     */
    if ((p === '/api/block' || p === '/api/unblock') && req.method === 'POST') {
      const name = url.searchParams.get('name');
      if (!name) return json(res, { error: 'no author' }, 400);
      db.exec('BEGIN');
      try {
        if (p === '/api/block') {
          db.prepare("INSERT OR REPLACE INTO blocked (name, at) VALUES (?, datetime('now'))")
            .run(name);
        } else {
          db.prepare('DELETE FROM blocked WHERE name = ?').run(name);
        }
        const blocked = new Set(db.prepare('SELECT name FROM blocked').all().map((r) => r.name));
        const mine = db.prepare("SELECT work_id, authors FROM works WHERE authors LIKE ? ESCAPE '\\'")
          .all(worksByPattern(name));
        const mark = db.prepare('UPDATE works SET hidden = ? WHERE work_id = ?');
        for (const row of mine) mark.run(isHidden(row.authors, blocked) ? 1 : 0, row.work_id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        return json(res, { error: e.message }, 500);
      }
      return json(res, { ok: true });
    }

    /* Whose bookmark list these works are in. */
    if (p === '/api/bookmarked-by' && req.method === 'POST') {
      const person = url.searchParams.get('person');
      if (!person) return json(res, { error: 'no person' }, 400);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let ids = [];
      try { ids = JSON.parse(Buffer.concat(chunks).toString() || '[]'); } catch { ids = []; }
      const note = db.prepare(
        "INSERT OR IGNORE INTO bookmarked_by (person, work_id, at) VALUES (?,?,datetime('now'))");
      db.exec('BEGIN');
      try {
        for (const id of ids) note.run(person, String(id));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        return json(res, { error: e.message }, 500);
      }
      return json(res, { ok: true });
    }

    /* The work is gone either way; this only drops the refusal. */
    if (p === '/api/allow' && req.method === 'POST') {
      const workId = url.searchParams.get('workId');
      if (!workId) return json(res, { error: 'no work' }, 400);
      db.prepare('DELETE FROM deleted WHERE work_id = ?').run(workId);
      return json(res, { ok: true });
    }

    /*
     * Finished, said rather than inferred.
     *
     * A chapter counts as complete once you have left it, so reading the last
     * one stores every chapter but that one. Nothing ever wrote the last, and
     * a work read end to end in this app stayed "reading" for ever. The count
     * comes from the database rather than from whatever the page believed:
     * the same fallback the reading states use, so finished means exactly
     * what not-reading means.
     */
    if (p === '/api/finished' && req.method === 'POST') {
      const workId = url.searchParams.get('workId');
      if (!workId) return json(res, { error: 'no work' }, 400);
      if (url.searchParams.get('done') === '0') {
        db.prepare(`UPDATE reading
          SET chapters_read = max(0, COALESCE(chapter, 1) - 1), updated_at = datetime('now')
          WHERE work_id = ?`).run(workId);
      } else {
        db.prepare(`
          INSERT INTO reading (work_id, chapters_read, updated_at, opened_at)
          SELECT w.work_id, ${CHAPTERS}, datetime('now'), datetime('now')
          FROM works w WHERE w.work_id = ?
          ON CONFLICT(work_id) DO UPDATE SET
            chapters_read = excluded.chapters_read, updated_at = excluded.updated_at`).run(workId);
      }
      return json(res, { ok: true });
    }

    /* Opened, without saying where in it — a peek from a search result must
       not move the bookmark, but it is still reading. */
    if (p === '/api/visit' && req.method === 'POST') {
      const workId = url.searchParams.get('workId'), visitId = url.searchParams.get('visitId');
      if (!workId || !visitId || visitId.length > 100) return json(res, { error: 'invalid visit' }, 400);
      db.prepare(RECORD_VISIT).run(visitId, workId);
      return json(res, { ok: true });
    }

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
    let m;
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
