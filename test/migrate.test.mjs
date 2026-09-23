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
  assert.throws(() => db.prepare(q.sql).all(...q.args), /no such (?:column: w\.rec|table: reading_visits)/,
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


test('opening an older EPUB library derives availability from its saved chapters', () => {
  const db = oldLibrary();
  db.exec("UPDATE works SET source='epub' WHERE work_id='1'");
  db.exec("INSERT INTO chapters(work_id,number,html) VALUES('1',1,'<p>The saved copy.</p>')");
  db.exec("INSERT INTO reading(work_id,chapter,chapters_read) VALUES('1',1,0)");
  ensureColumns(db);
  assert.equal(db.prepare('SELECT has_text FROM works').get().has_text, 1);
  const held = buildWorksQuery({ availability: 'held' });
  assert.deepEqual(db.prepare(held.sql).all(...held.args).map(w => w.work_id), ['1']);
  assert.equal(db.prepare('SELECT html FROM chapters').get().html, '<p>The saved copy.</p>');
  assert.equal(db.prepare('SELECT chapter FROM reading').get().chapter, 1);
  db.close();
});

test('availability repair corrects stale flags in an already current database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec(`INSERT INTO works(work_id,source,has_text) VALUES
    ('epub','epub',0), ('archive','ao3',NULL), ('stub','ao3',1), ('version','epub',1);
    INSERT INTO chapters(work_id,number,html) VALUES
    ('epub',1,'<p>EPUB text</p>'), ('archive',1,'<p>Saved from AO3</p>');
    INSERT INTO chapter_versions(work_id,number,html) VALUES('version',1,'<p>An earlier copy</p>');`);
  ensureColumns(db);
  assert.deepEqual(db.prepare('SELECT work_id,has_text FROM works ORDER BY work_id').all().map(r => [r.work_id,r.has_text]),
    [['archive',1],['epub',1],['stub',0],['version',0]]);
  assert.deepEqual(ensureColumns(db), []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM chapter_versions').get().n, 1);
  db.close();
});

test('Android applies the same availability repair on database open and before import', async () => {
  const { readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { REPAIR_AVAILABILITY } = await import('../app/core/store/availability.js');
  assert.equal(execFileSync(process.execPath, ['tools/emit-availability-sql.mjs'], { encoding: 'utf8' }), REPAIR_AVAILABILITY);
  const java = readFileSync('android/src/org/fanfolio/MainActivity.java', 'utf8');
  const migrate = java.slice(java.indexOf('private void migrate(SQLiteDatabase db)'), java.indexOf('private void repairCompleteness('));
  assert.match(migrate, /db.execSQL\(readAsset\("web\/availability.sql"\)\)/);
  assert.match(java, /migrate\(incoming\)/);
  assert.match(readFileSync('android/build.sh', 'utf8'), /emit-availability-sql.mjs > assets\/web\/availability.sql/);
});
