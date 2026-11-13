/**
 * The routes, run rather than read.
 *
 * Much of what is known about these queries was known by matching their
 * source text. This asks them the questions the app asks, over a real
 * database, with every argument bound as text the way Android binds them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../app/core/store/schema.js';
import { createReadRoutes } from '../app/core/routes.js';

function library() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const work = db.prepare(`INSERT INTO works (work_id,title,authors,summary,has_text,chapter_count,words,rating,complete,updated,downloaded_at)
    VALUES (?,?,?,?,?,?,?,'General Audiences',1,'2026-09-01','2026-09-02')`);
  const tag = db.prepare('INSERT INTO tags (work_id,kind,name) VALUES (?,?,?)');
  const chapter = db.prepare('INSERT INTO chapters (work_id,number,title,html,text,words) VALUES (?,?,?,?,?,?)');
  work.run('1', 'Apple orchard', '["Rowan"]', 'An orchard in autumn.', 1, 2, 9000);
  work.run('2', 'Zebra crossing', '["Ash"]', 'A street at night.', 1, 1, 500);
  work.run('3', 'Middle distance', '["Rowan"]', 'Not yet fetched.', 0, 1, 4000);
  for (const id of ['1', '2', '3']) tag.run(id, 'fandom', 'The Harbour');
  tag.run('1', 'relationship', 'A/B');
  tag.run('1', 'relationship', 'C/D');
  chapter.run('1', 1, 'One', '<p>Rain on the <em>orchard</em>.</p><script>alert(1)</script>', 'Rain on the orchard.', 4500);
  chapter.run('1', 2, 'Two', '<p>The harvest.</p>', 'The harvest.', 4500);
  chapter.run('2', 1, 'Only', '<p>Rain on the crossing.</p>', 'Rain on the crossing.', 500);
  db.prepare(`INSERT INTO reading (work_id,chapter,offset,chapters_read,chapter_count,updated_at,opened_at) VALUES ('1',2,0,1,2,'2026-11-01','2026-11-01')`).run();
  db.exec("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')");
  db.exec("INSERT INTO work_fts(rowid,work_id,title,authors,summary,tags) SELECT rowid,work_id,title,authors,summary,'' FROM works");
  const asked = [];
  const sql = (query, args = []) => { asked.push(args); return db.prepare(query).all(...args.map(String)); };
  return { routes: createReadRoutes(sql), asked };
}

test('the Library lists works, counts them, and pages', () => {
  const { routes } = library();
  const all = routes.read('/api/works?sort=title&state=all&limit=2&offset=0');
  assert.equal(all.total, 3);
  assert.deepEqual(all.works.map(w => w.title), ['Apple orchard', 'Middle distance']);
  assert.equal(all.works[0].relationships, 'A/B\nC/D');
  const rest = routes.read('/api/works?sort=title&state=all&limit=2&offset=2');
  assert.deepEqual(rest.works.map(w => w.title), ['Zebra crossing']);
});

test('filters narrow it: what is held, what is being read, shortest first', () => {
  const { routes } = library();
  assert.equal(routes.read('/api/works?sort=title&state=all&availability=held').total, 2);
  assert.deepEqual(routes.read('/api/works?sort=recent&state=reading').works.map(w => w.title), ['Apple orchard']);
  assert.deepEqual(routes.read('/api/works?sort=shortest&state=all').works.map(w => w.title),
    ['Zebra crossing', 'Middle distance', 'Apple orchard']);
  assert.deepEqual(routes.read('/api/works?sort=title&state=all&wordsMin=1000&wordsMax=5000').works.map(w => w.title),
    ['Middle distance'], 'a number bound as text still compares as a number');
});

test('a work comes with its tags, chapters and place', () => {
  const { routes } = library();
  const work = routes.read('/api/works/1');
  assert.equal(work.title, 'Apple orchard');
  assert.deepEqual(work.tags.relationship, ['A/B', 'C/D']);
  assert.equal(work.chapters.length, 2);
  assert.equal(work.at_chapter, 2);
  assert.throws(() => routes.read('/api/works/999'), /no such work/);
});

test('a chapter is handed back sanitised', () => {
  const { routes } = library();
  const chapter = routes.read('/api/works/1/chapters/1');
  assert.equal(chapter.number, 1);
  const rendered = JSON.stringify(chapter);
  assert.match(rendered, /orchard/);
  assert.equal(/<script/i.test(rendered), false);
  assert.throws(() => routes.read('/api/works/1/chapters/9'), /no such chapter/);
});

test('Home has a Continue reading shelf with what is being read', () => {
  const { routes } = library();
  const home = routes.read('/api/home');
  const reading = home.shelves.find(s => s.key === 'reading');
  assert.deepEqual(reading.works.map(w => w.title), ['Apple orchard']);
  assert.equal(reading.total, 1);
});

test('search finds passages, and a half-typed query is not a fault', () => {
  const { routes } = library();
  const found = routes.read('/api/search?q=rain&scope=text');
  assert.equal(found.hits.length, 2);
  assert.match(found.hits[0].snippet, /<mark>Rain<\/mark>/i);
  const broken = routes.read('/api/search?q=%22&scope=text');
  assert.deepEqual([broken.hits, broken.works, broken.tags].map(a => a.length), [0, 0, 0]);
});

test('facets count what the current filters leave', () => {
  const { routes } = library();
  const facets = routes.read('/api/facets?sort=title&state=all');
  assert.ok(JSON.stringify(facets).includes('The Harbour'));
});

test('a path that is not a read is left for someone else', () => {
  const { routes } = library();
  assert.equal(routes.read('/api/prefs'), undefined);
  assert.equal(routes.read('/index.html'), undefined);
});

test('nothing a reader can type reaches the SQL except as a bound argument', () => {
  const { routes, asked } = library();
  const hostile = "x' OR 1=1 --";
  const answer = routes.read(`/api/works?sort=title&state=all&author=${encodeURIComponent(hostile)}`);
  assert.equal(answer.total, 0);
  assert.ok(asked.some(args => args.some(a => String(a).includes(hostile))), 'it travelled as an argument');
});
