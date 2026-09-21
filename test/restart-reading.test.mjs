import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA, ensureColumns } from '../app/core/store/schema.js';
import { RESTART_READING } from '../app/core/store/reading.js';
import { buildWorksQuery } from '../app/core/query.js';
import { readingStatus } from '../app/core/reading.js';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const library = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec("INSERT INTO works(work_id,chapter_count,has_text) VALUES('1',4,1)");
  return db;
};
const matches = (db, state) => {
  const q = buildWorksQuery({ state });
  return db.prepare(q.sql).all(...q.args).map(w => w.work_id);
};

test('restarting preserves completion, later membership and puts the work back into Reading', () => {
  const db = library();
  db.exec("INSERT INTO reading(work_id,chapter,offset,chapters_read,marked_later) VALUES('1',4,600,4,1)");
  db.prepare(RESTART_READING).run('1');
  const row = db.prepare('SELECT * FROM reading').get();
  assert.equal(row.chapter, 1);
  assert.equal(row.offset, 0);
  assert.equal(row.chapters_read, 0);
  assert.equal(row.completed_before, 1);
  assert.equal(row.marked_later, 1);
  assert.ok(row.opened_at);
  assert.deepEqual(matches(db, 'reading'), ['1']);
  assert.deepEqual(matches(db, 'finished'), ['1'], 'earlier completion remains discoverable');
  db.prepare(RESTART_READING).run('1');
  assert.equal(db.prepare('SELECT completed_before FROM reading').get().completed_before, 1);
  db.close();
});

test('starting an unfinished work again does not invent a previous completion', () => {
  const db = library();
  db.exec("INSERT INTO reading(work_id,chapter,chapters_read) VALUES('1',3,2)");
  db.prepare(RESTART_READING).run('1');
  assert.equal(db.prepare('SELECT completed_before FROM reading').get().completed_before, 0);
  assert.deepEqual(matches(db, 'finished'), []);
  db.close();
});

test('older databases gain prior-completion state without moving their reading position', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE reading(work_id TEXT PRIMARY KEY, chapter INTEGER, offset REAL, chapters_read INTEGER)");
  db.exec("INSERT INTO reading VALUES('1',3,450,2)");
  assert.ok(ensureColumns(db).includes('completed_before'));
  const row = db.prepare('SELECT * FROM reading').get();
  assert.equal(row.completed_before, 0);
  assert.equal(row.chapter, 3);
  assert.equal(row.offset, 450);
  assert.equal(row.chapters_read, 2);
  assert.deepEqual(ensureColumns(db), []);
  db.close();
});

test('resume advances to an added chapter after catching up, but preserves an unfinished chapter', () => {
  assert.equal(readingStatus({ chapter_count: 5, chapters_read: 4, at_chapter: 4 }).at, 5);
  assert.equal(readingStatus({ chapter_count: 5, chapters_read: 3, at_chapter: 4, offset: 600 }).at, 4);
  assert.equal(readingStatus({ chapter_count: 5, chapters_read: 0, at_chapter: 1, opened_at: 'today' }).started, true);
  assert.equal(readingStatus({ chapter_count: 5, chapters_read: 0, at_chapter: 1, marked_later: 1 }).started, false);
});

test('Android receives the same restart statement exercised against SQLite', () => {
  const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const build = readFileSync(new URL('../android/build.sh', import.meta.url), 'utf8');
  assert.ok(java.includes('db.execSQL(readAsset("web/restart-reading.sql"), new Object[]{ workId })'));
  assert.ok(build.includes('tools/emit-reading-sql.mjs > assets/web/restart-reading.sql'));
  const emitted = execFileSync(process.execPath, ['tools/emit-reading-sql.mjs'], { encoding: 'utf8' });
  assert.equal(emitted, RESTART_READING);
});
