/**
 * Queries that do not hold the page still, and what happens when they cannot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../app/core/store/schema.js';
import { createReadRoutes, createAsyncReadRoutes } from '../app/core/routes.js';

function library() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const work = db.prepare(`INSERT INTO works (work_id,title,authors,summary,has_text,chapter_count,words,rating,complete,updated,downloaded_at)
    VALUES (?,?,?,?,1,1,?,'General Audiences',1,'2026-09-01','2026-09-02')`);
  work.run('1', 'Apple orchard', '["Rowan"]', 'An orchard.', 9000);
  work.run('2', 'Zebra crossing', '["Ash"]', 'A street.', 500);
  for (const id of ['1', '2']) {
    db.prepare('INSERT INTO tags (work_id,kind,name) VALUES (?,?,?)').run(id, 'fandom', 'The Harbour');
    db.prepare('INSERT INTO chapters (work_id,number,title,html,text,words) VALUES (?,1,?,?,?,100)')
      .run(id, 'One', '<p>Rain on the road.</p>', 'Rain on the road.');
  }
  db.exec("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')");
  db.exec("INSERT INTO work_fts(rowid,work_id,title,authors,summary,tags) SELECT rowid,work_id,title,authors,summary,'' FROM works");
  return (query, args = []) => db.prepare(query).all(...args.map(String));
}

const PATHS = ['/api/works?sort=title&state=all', '/api/home', '/api/facets?sort=title&state=all',
  '/api/works/1', '/api/works/1/chapters/1', '/api/search?q=rain&scope=text', '/api/search?q=%22&scope=text',
  '/api/facet-search?kind=fandom&q=har&sort=title&state=all'];

test('asked later, every route answers what it answers at once', async () => {
  const sql = library();
  const now = createReadRoutes(sql);
  const later = createAsyncReadRoutes(async (query, args) => { await new Promise(r => setImmediate(r)); return sql(query, args); });
  for (const path of PATHS) {
    const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'ms' ? undefined : v)));
    // Home shuffles one shelf, so it is compared by shape rather than order.
    const [a, b] = [strip(now.read(path)), strip(await later.read(path))];
    if (path === '/api/home') assert.deepEqual(b.shelves.map(s => [s.key, s.total]), a.shelves.map(s => [s.key, s.total]));
    else assert.deepEqual(b, a, path);
  }
});

test('each query is run once, however many times the route is started again', async () => {
  const sql = library();
  const seen = [];
  const later = createAsyncReadRoutes(async (query, args) => { seen.push(query + JSON.stringify(args)); return sql(query, args); });
  await later.read('/api/facets?sort=title&state=all');
  assert.ok(seen.length > 5);
  assert.equal(new Set(seen).size, seen.length);
});

test('a failed query fails the read, and a missing work is still a missing work', async () => {
  const sql = library();
  const broken = createAsyncReadRoutes(async () => { throw new Error('disk gone'); });
  await assert.rejects(broken.read('/api/works?sort=title&state=all'), /disk gone/);
  const later = createAsyncReadRoutes(async (q, a) => sql(q, a));
  await assert.rejects(later.read('/api/works/999'), /no such work/);
  assert.equal(await later.read('/api/prefs'), undefined);
});

/* The app's own use of it, against a pretend shell. */
async function appWith(native) {
  const calls = { sync: 0, async: 0 };
  const sql = library();
  const answers = new Map();
  globalThis.window = {
    ArchiveNative: {
      query: (query, args) => { calls.sync++; return JSON.stringify({ rows: sql(query, JSON.parse(args)) }); },
      ...native({ sql, answers, calls, done: (id) => globalThis.window.__queryDone(id) }),
    },
  };
  const api = await import(`../app/api.js?shell=${Math.random()}`);
  return { api, calls };
}

test('with a shell that offers it, the page asks and does not wait', async () => {
  const { api, calls } = await appWith(({ sql, answers, calls, done }) => ({
    queryAsync: (id, query, args) => {
      calls.async++;
      setTimeout(() => { answers.set(id, JSON.stringify({ rows: sql(query, JSON.parse(args)) })); done(id); }, 1);
    },
    takeQuery: (id) => { const a = answers.get(id); answers.delete(id); return a ?? '{"error":"no such query"}'; },
  }));
  const out = await api.api('/api/works?sort=title&state=all');
  assert.deepEqual(out.works.map(w => w.title), ['Apple orchard', 'Zebra crossing']);
  assert.equal(calls.sync, 0, 'nothing went the waiting way');
  assert.ok(calls.async >= 2);
  delete globalThis.window;
});

test('an older shell without it is asked the way it always was', async () => {
  const { api, calls } = await appWith(() => ({}));
  const out = await api.api('/api/works?sort=title&state=all');
  assert.equal(out.total, 2);
  assert.ok(calls.sync >= 2);
  delete globalThis.window;
});

test('a shell that throws, or never answers, costs a pause and not the library', async () => {
  const thrown = await appWith(({ calls }) => ({
    queryAsync: () => { calls.async++; throw new Error('bridge fault'); },
    takeQuery: () => '{"error":"no such query"}',
  }));
  assert.equal((await thrown.api.api('/api/works?sort=title&state=all')).total, 2);
  assert.equal(thrown.calls.async, 1, 'tried once, then left alone');
  delete globalThis.window;

  const silent = await appWith(({ calls }) => ({
    queryAsync: () => { calls.async++; },
    takeQuery: () => '{"error":"no such query"}',
  }));
  const started = Date.now();
  assert.equal((await silent.api.api('/api/works?sort=title&state=all')).total, 2);
  assert.ok(Date.now() - started < 9000);
  assert.equal(silent.calls.async, 1, 'one missed answer, and every later query goes the old way');
  assert.equal((await silent.api.api('/api/works/1')).title, 'Apple orchard');
  assert.equal(silent.calls.async, 1);
  delete globalThis.window;
});

test('the shell runs the handed-over query through the same checks, off the UI thread', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/FolioRuntime.java', import.meta.url), 'utf8');
  const at = java.indexOf('public void queryAsync(');
  const body = java.slice(at, java.indexOf('public String takeQuery(', at));
  assert.match(body, /mustBeOurPage\(\);/);
  assert.match(body, /queryThread\.execute\(/);
  assert.match(body, /answer = query\(sql, argsJson\);/, 'the read-only checks live in query() and are not restated');
  assert.match(body, /QUERY_ID\.matcher\(id\)\.matches\(\)/, 'the id is written into a script, so its shape is fixed');
  assert.match(java, /QUERY_ID = java\.util\.regex\.Pattern\.compile\("q\[0-9\]\{1,12\}"\)/);
});
