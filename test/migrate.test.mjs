import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA, ensureColumns } from '../app/core/store/schema.js';
import { buildWorksQuery } from '../app/core/query.js';

/**
 * A library as it existed before recs were added — which is what is sitting on
 * a phone that imported its database at any point before that.
 */
function oldLibrary() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE works (
    work_id TEXT PRIMARY KEY, title TEXT, authors TEXT, summary TEXT,
    rating TEXT, language TEXT, published TEXT, updated TEXT,
    downloaded_at TEXT, complete INTEGER, words INTEGER,
    chapter_count INTEGER, chapters_planned INTEGER, updated_at INTEGER,
    skin_css TEXT, skin_hash TEXT, end_notes_html TEXT,
    source TEXT, source_file TEXT, fetched_at TEXT);
    CREATE TABLE reading (work_id TEXT PRIMARY KEY, chapter INTEGER,
      chapters_read INTEGER, marked_later INTEGER);
    CREATE TABLE tags (work_id TEXT, kind TEXT, name TEXT);
    CREATE TABLE chapters (id INTEGER PRIMARY KEY, work_id TEXT, number INTEGER,
      html TEXT);`);
  db.prepare('INSERT INTO works (work_id, title, complete) VALUES (?,?,?)').run('1', 'Alpha', 1);
  return db;
}

test('the library query fails on a database from before recs', () => {
  const db = oldLibrary();
  const q = buildWorksQuery({});
  assert.throws(() => db.prepare(q.sql).all(...q.args), /no such column: w\.rec/,
    'this is the error that took out the whole library');
});

test('migrating an old database makes it queryable again', () => {
  const db = oldLibrary();
  const added = ensureColumns(db);
  assert.ok(added.includes('rec'), 'rec is the column that broke it');
  assert.ok(added.includes('in_bookmarks') && added.includes('in_history'));

  const q = buildWorksQuery({});
  const rows = db.prepare(q.sql).all(...q.args);
  assert.deepEqual(rows.map((r) => r.work_id), ['1']);
  assert.equal(rows[0].rec, 0, 'a work nobody has marked is not a rec');
});

test('migrating twice adds nothing the second time', () => {
  const db = oldLibrary();
  ensureColumns(db);
  assert.deepEqual(ensureColumns(db), [], 'it runs on every open; it must be idempotent');
});

test('a current database is left completely alone', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  assert.deepEqual(ensureColumns(db), []);
});

test('the reading columns are migrated too, not just the works ones', () => {
  const db = oldLibrary();
  const added = ensureColumns(db);
  assert.ok(added.includes('opened_at') && added.includes('offset'),
    'what is being read now asks the reading table for both of these');
  const have = db.prepare('PRAGMA table_info(reading)').all().map((r) => r.name);
  assert.ok(have.includes('opened_at') && have.includes('offset'));
});

test('every state filter works after migrating', () => {
  const db = oldLibrary();
  ensureColumns(db);
  for (const state of ['all', 'rec', 'bookmarked', 'history', 'reading', 'unread', 'finished', 'later']) {
    const q = buildWorksQuery({ state });
    assert.doesNotThrow(() => db.prepare(q.sql).all(...q.args), `state=${state} still fails`);
  }
});
