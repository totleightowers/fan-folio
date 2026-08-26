import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildWorksQuery, buildFacetQuery, SORTS, STATES } from '../app/core/query.js';
import { SCHEMA } from '../app/core/store/schema.js';

/** A small library with known contents, so counts can be asserted exactly. */
function library() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const work = db.prepare(`INSERT INTO works
    (work_id, title, authors, words, chapter_count, complete, rating, language, published)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const tag = db.prepare('INSERT INTO tags (work_id, kind, name) VALUES (?,?,?)');
  const read = db.prepare('INSERT INTO reading (work_id, chapter, chapters_read, marked_later) VALUES (?,?,?,?)');

  work.run('1', 'Alpha', '["ann"]', 1000, 5, 1, 'Explicit', 'en', '2020-01-01');
  work.run('2', 'Bravo', '["bee"]', 50000, 10, 0, 'Teen And Up Audiences', 'en', '2021-01-01');
  work.run('3', 'Charlie', '["cee"]', 5000, 3, 1, 'Explicit', 'fr', '2022-01-01');

  tag.run('1', 'fandom', 'BTS'); tag.run('1', 'freeform', 'Fluff');
  tag.run('2', 'fandom', 'BTS'); tag.run('2', 'freeform', 'Angst');
  tag.run('3', 'fandom', 'EXO'); tag.run('3', 'freeform', 'Fluff');

  read.run('1', 5, 1, 0);      // part read
  read.run('3', 1, 0, 1);      // marked for later, unread
  return db;
}

const run = (db, filters) => {
  const q = buildWorksQuery(filters);
  return db.prepare(q.sql).all(...q.args).map((r) => r.work_id);
};
const count = (db, filters) => {
  const q = buildWorksQuery(filters);
  return db.prepare(q.countSql).get(...q.args).n;
};

test('no filters returns everything, titled order', () => {
  assert.deepEqual(run(library(), {}), ['1', '2', '3']);
});

test('included tags are ANDed, not ORed', () => {
  const db = library();
  assert.deepEqual(run(db, { include: ['BTS'] }), ['1', '2']);
  assert.deepEqual(run(db, { include: ['BTS', 'Fluff'] }), ['1'], 'both tags, not either');
});

test('excluded tags remove works', () => {
  assert.deepEqual(run(library(), { exclude: ['Angst'] }), ['1', '3']);
});

test('include and exclude combine', () => {
  assert.deepEqual(run(library(), { include: ['Fluff'], exclude: ['EXO'] }), ['1']);
});

test('ratings are ORed', () => {
  const db = library();
  assert.deepEqual(run(db, { rating: ['Explicit'] }), ['1', '3']);
  assert.deepEqual(run(db, { rating: ['Explicit', 'Teen And Up Audiences'] }), ['1', '2', '3']);
});

test('completion, language and ranges filter', () => {
  const db = library();
  assert.deepEqual(run(db, { complete: '0' }), ['2']);
  assert.deepEqual(run(db, { language: 'fr' }), ['3']);
  assert.deepEqual(run(db, { wordsMin: 4000, wordsMax: 60000 }), ['2', '3']);
  assert.deepEqual(run(db, { chaptersMin: 3 }), ['1', '2', '3']);
});

test('reading state filters use the reading table', () => {
  const db = library();
  assert.deepEqual(run(db, { state: 'reading' }), ['1']);
  assert.deepEqual(run(db, { state: 'later' }), ['3']);
  assert.deepEqual(run(db, { state: 'unread' }), ['2', '3']);
});

test('count matches the rows returned', () => {
  const db = library();
  assert.equal(count(db, { include: ['BTS'] }), 2);
  assert.equal(count(db, {}), 3);
});

test('an unknown sort falls back rather than reaching SQL', () => {
  const q = buildWorksQuery({ sort: "title; DROP TABLE works--" });
  assert.ok(q.sql.includes(SORTS.title));
  assert.ok(!q.sql.includes('DROP'), 'a crafted sort must never reach the query');
});

test('an unknown state falls back to all', () => {
  const q = buildWorksQuery({ state: 'nonsense' });
  assert.ok(q.sql.includes(STATES.all));
});

test('tag values are bound, never interpolated', () => {
  const q = buildWorksQuery({ include: ["' OR 1=1 --"] });
  assert.ok(!q.sql.includes('OR 1=1'), 'the value must not appear in the SQL text');
  assert.deepEqual(q.args, ["' OR 1=1 --"]);
  // and it simply matches nothing
  assert.deepEqual(run(library(), { include: ["' OR 1=1 --"] }), []);
});

test('limit and offset are clamped integers', () => {
  const q = buildWorksQuery({ limit: '9999', offset: 'abc' });
  assert.ok(q.sql.includes('LIMIT 200'), 'clamped to the maximum');
  assert.ok(q.sql.includes('OFFSET 0'), 'nonsense offset becomes zero');
});

test('facets count within the current filter, not the whole library', () => {
  const db = library();
  // node:sqlite hands back null-prototype rows, so compare plain shapes
  const plain = (rows) => rows.map((r) => ({ name: r.name, n: r.n }));

  const all = buildFacetQuery({}, 'freeform');
  assert.deepEqual(plain(db.prepare(all.sql).all(...all.args)),
    [{ name: 'Fluff', n: 2 }, { name: 'Angst', n: 1 }]);

  const narrowed = buildFacetQuery({ include: ['EXO'] }, 'freeform');
  assert.deepEqual(plain(db.prepare(narrowed.sql).all(...narrowed.args)), [{ name: 'Fluff', n: 1 }],
    'narrowing must not offer tags that would yield nothing');
});

test('an unknown tag kind is refused', () => {
  assert.throws(() => buildFacetQuery({}, 'nonsense; DROP TABLE tags'), /unknown tag kind/);
});
