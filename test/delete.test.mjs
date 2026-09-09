import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { SCHEMA } from '../app/core/store/schema.js';
import { INDEX_FIRST, WORK_OWNS, deleteStatements, TOMBSTONE } from '../app/core/store/delete.js';

/**
 * A work is not one row.
 *
 * It is a row, its tags, its chapters, two search indexes, the pictures
 * fetched for it, the copies kept of chapters an author revised, the skin it
 * was published with, and where the reader had got to in it. Deleting the work
 * and leaving any of those behind is a library that grows a little every time
 * somebody tidies it — so this builds one with something in every table it
 * touches, and then checks all of them.
 */
function libraryWithOneWorkInEveryTable() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);

  db.prepare(`INSERT INTO works (work_id, title, authors, words, chapter_count, skin_css)
    VALUES (?,?,?,?,?,?)`).run('1', 'Alpha', '["ann"]', 4200, 2, 'p { color: red }');
  db.prepare('INSERT INTO tags (work_id, kind, name) VALUES (?,?,?)').run('1', 'fandom', 'BTS');

  const chapter = db.prepare(
    'INSERT INTO chapters (work_id, number, title, html, text, words) VALUES (?,?,?,?,?,?)');
  chapter.run('1', 1, 'One', '<p>the first</p>', 'the first', 2000);
  chapter.run('1', 2, 'Two', '<p>the second</p>', 'the second', 2200);
  db.exec("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')");
  db.prepare('INSERT INTO work_fts (work_id, title, authors, summary, tags) VALUES (?,?,?,?,?)')
    .run('1', 'Alpha', 'ann', '', 'BTS');

  db.prepare(`INSERT INTO chapter_versions (work_id, number, html, reason, archived_at)
    VALUES (?,?,?,?,?)`).run('1', 1, '<p>an older first</p>', 'content', '2026-01-01');
  db.prepare('INSERT INTO skin_versions (work_id, skin_css, archived_at) VALUES (?,?,?)')
    .run('1', 'p { color: blue }', '2026-01-01');
  db.prepare('INSERT INTO images (work_id, url, status) VALUES (?,?,?)')
    .run('1', 'https://example.test/a.png', 'stored');
  db.prepare('INSERT INTO reading (work_id, chapter, chapters_read) VALUES (?,?,?)').run('1', 2, 1);

  /* A second work, to catch a delete that takes more than it was asked for. */
  db.prepare('INSERT INTO works (work_id, title, authors) VALUES (?,?,?)')
    .run('2', 'Bravo', '["bee"]');
  db.prepare('INSERT INTO tags (work_id, kind, name) VALUES (?,?,?)').run('2', 'fandom', 'EXO');
  chapter.run('2', 1, 'One', '<p>elsewhere</p>', 'elsewhere', 900);
  db.exec("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')");

  return db;
}

/** Exactly what both backends run, in the order they run it. */
function deleteWork(db, workId) {
  const title = db.prepare('SELECT title FROM works WHERE work_id = ?').get(workId)?.title ?? null;
  db.exec('BEGIN');
  for (const row of db.prepare('SELECT id FROM chapters WHERE work_id = ?').all(workId)) {
    db.prepare(`DELETE FROM ${INDEX_FIRST} WHERE rowid = ?`).run(row.id);
  }
  for (const sql of deleteStatements()) db.prepare(sql).run(workId);
  db.prepare(TOMBSTONE).run(workId, title);
  db.exec('COMMIT');
}

test('deleting a work leaves nothing of it behind', () => {
  const db = libraryWithOneWorkInEveryTable();
  for (const table of WORK_OWNS) {
    const n = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE work_id = ?`).get('1').n;
    assert.ok(n > 0, `the fixture should have something in ${table}`);
  }

  deleteWork(db, '1');

  for (const table of WORK_OWNS) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE work_id = ?`).get('1').n, 0,
      `${table} still holds part of a work that was deleted`);
  }
});

test('the search index keeps no entry pointing at a chapter that is gone', () => {
  const db = libraryWithOneWorkInEveryTable();
  const hits = () => db.prepare(
    "SELECT count(*) AS n FROM chapter_fts WHERE chapter_fts MATCH 'first'").get().n;
  assert.equal(hits(), 1, 'the fixture is indexed');

  deleteWork(db, '1');

  /* chapter_fts is external-content FTS4 keyed on chapters.rowid. Delete the
     chapters first and the index still answers, pointing at rows that are not
     there — so a search finds a work it cannot open. That is why the index
     goes first and by hand. */
  assert.equal(hits(), 0, 'a search still finds a work that has been deleted');
});

test('a delete takes only the work it was asked for', () => {
  const db = libraryWithOneWorkInEveryTable();
  deleteWork(db, '1');
  assert.equal(db.prepare('SELECT count(*) AS n FROM works').get().n, 1);
  assert.equal(db.prepare('SELECT title FROM works').get().title, 'Bravo');
  assert.equal(db.prepare("SELECT count(*) AS n FROM chapter_fts WHERE chapter_fts MATCH 'elsewhere'")
    .get().n, 1, 'somebody else’s chapter is still findable');
});

test('what makes it stay deleted is written down in the same breath', () => {
  const db = libraryWithOneWorkInEveryTable();
  deleteWork(db, '1');
  const stone = db.prepare('SELECT work_id, title FROM deleted').get();
  assert.equal(stone.work_id, '1');
  assert.equal(stone.title, 'Alpha',
    'the undo list names what it holds rather than showing a row of numbers');
});

test('the shell lets go of everything the shared list names', () => {
  const java = readFileSync(
    new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
  const list = java.slice(java.indexOf('String[] WORK_OWNS = {'));
  const named = new Set([...list.slice(0, list.indexOf('};')).matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1]));

  /* Two implementations of "everything a work owns", in two languages,
     neither able to import the other. The list is in one place and both are
     held to it — the arrangement the reading predicate and the bookmark
     reconciliation ended up with, for the same reason. */
  assert.deepEqual(WORK_OWNS.filter((t) => !named.has(t)), []);

  const fn = java.slice(java.indexOf('public String deleteWork('));
  const body = fn.slice(0, fn.indexOf('\n        }\n'));
  assert.match(body, /SELECT id FROM chapters WHERE work_id/,
    'the index is cleared by chapter rowid, before the chapters go');
  assert.ok(body.indexOf('chapter_fts') < body.indexOf('for (String table : WORK_OWNS)'),
    'and it is cleared first');
  assert.match(body, /beginTransaction/, 'a half-deleted work is not a state to end in');
  assert.match(body, /INSERT OR REPLACE INTO deleted/);
});
