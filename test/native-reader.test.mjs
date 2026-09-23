import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../app/core/store/schema.js';

const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);
globalThis.window = { ArchiveNative: {
  query(sql, args) {
    return JSON.stringify({ rows: db.prepare(sql).all(...JSON.parse(args)) });
  },
} };
const { api } = await import('../app/api.js');
delete globalThis.window;

for (const workId of ['epub-1abc', '123']) {
  test(`open a stored work, chapter and earlier version: ${workId}`, async () => {
    db.prepare('INSERT INTO works (work_id,title,authors,has_text,chapter_count) VALUES (?,?,?,?,?)')
      .run(workId, 'A book', '[]', 1, 1);
    db.prepare('INSERT INTO chapters (work_id,number,html) VALUES (?,?,?)')
      .run(workId, 1, '<p>Current words.</p>');
    const { lastInsertRowid } = db.prepare('INSERT INTO chapter_versions (work_id,number,html) VALUES (?,?,?)')
      .run(workId, 1, '<p>Earlier words.</p>');
    assert.ok((await api('/api/works')).works.some(w => w.work_id === workId));
    assert.equal((await api(`/api/works/${workId}`)).title, 'A book');
    assert.match((await api(`/api/works/${workId}/chapters/1`)).html, /Current words/);
    assert.equal((await api(`/api/works/${workId}/versions`)).versions.length, 1);
    assert.match((await api(`/api/works/${workId}/versions/${lastInsertRowid}`)).html, /Earlier words/);
  });
}

test('native Home cards include rating and relationship without inventing missing metadata', async () => {
  db.prepare('INSERT INTO works (work_id,title,authors,rating,chapter_count,has_text) VALUES (?,?,?,?,1,1)')
    .run('metadata', 'A story', '[]', 'Teen And Up Audiences');
  db.prepare('INSERT INTO tags (work_id,kind,name) VALUES (?,?,?)')
    .run('metadata', 'relationship', 'Alex & Sam');
  db.prepare('INSERT INTO reading (work_id,chapter,opened_at) VALUES (?,1,?)')
    .run('metadata', '2026-09-23');
  const { shelves } = await api('/api/home');
  for (const key of ['reading', 'added']) {
    const work = shelves.find(s => s.key === key).works.find(w => w.work_id === 'metadata');
    assert.equal(work.rating, 'Teen And Up Audiences');
    assert.equal(work.relationship, 'Alex & Sam');
  }
  const imported = shelves.find(s => s.key === 'added').works.find(w => w.work_id === 'epub-1abc');
  assert.equal(imported.rating, null);
  assert.equal(imported.relationship, null);
});

// Exercise the SQL Android actually runs, against the production schema.
const java = readFileSync(new URL('../android/src/org/fanfolio/MainActivity.java', import.meta.url), 'utf8');
const method = java.slice(java.indexOf('private void archiveSkin('), java.indexOf('\n    }', java.indexOf('private void archiveSkin(')));
const query = [...method.slice(method.indexOf('db.execSQL('), method.indexOf('new Object[]')).matchAll(/"(?:[^"\\]|\\.)*"/g)]
  .map(m => JSON.parse(m[0])).join('');

for (const [label, before, after, expected] of [
  ['changed', '.a { color: red }', '.a { color: blue }', 1],
  ['removed', '.a { color: red }', '', 1],
  ['unchanged', '.a { color: red }', '.a { color: red }', 0],
  ['first skin', null, '.a { color: red }', 0],
  ['no skin', null, '', 0],
  ['visible CSS whitespace', '.a::before { content: "a  b" }', '.a::before { content: "a b" }', 1],
]) {
  test(`Android preserves skin history: ${label}`, () => {
    const d = new DatabaseSync(':memory:');
    try {
      d.exec(SCHEMA);
      d.prepare('INSERT INTO works (work_id,skin_css,skin_hash) VALUES (?,?,?)').run('1', before, 'held-hash');
      const archive = d.prepare(query);
      archive.run('2026-09-13 12:00:00', '1', after);
      d.prepare('INSERT OR REPLACE INTO works (work_id,skin_css) VALUES (?,?)').run('1', after);
      const rows = d.prepare('SELECT * FROM skin_versions').all();
      assert.equal(rows.length, expected);
      if (expected) {
        assert.equal(rows[0].skin_css, before);
        assert.equal(rows[0].skin_hash, 'held-hash');
        assert.equal(rows[0].work_id, '1');
      }
      archive.run('2026-09-13 13:00:00', '1', after);
      assert.equal(d.prepare('SELECT count(*) n FROM skin_versions').get().n, expected,
        'an unchanged refetch must not add another version');
    } finally { d.close(); }
  });
}

test('Android archives the skin before overwriting the work inside the save transaction', () => {
  const write = java.slice(java.indexOf('private void writeWork('), java.indexOf('private void keepAsVersion('));
  assert.ok(write.indexOf('archiveSkin(id,') >= 0);
  assert.ok(write.indexOf('archiveSkin(id,') < write.indexOf('db.insertWithOnConflict("works"'));
  for (const name of ['saveWork', 'saveEpub']) {
    const body = java.slice(java.indexOf(`public String ${name}(`), java.indexOf('\n        /**', java.indexOf(`public String ${name}(`)));
    assert.ok(body.indexOf('db.beginTransaction()') < body.indexOf('writeWork(w, id)'));
    assert.ok(body.indexOf('db.endTransaction()') > body.indexOf('writeWork(w, id)'));
  }
  assert.ok(!method.includes('catch'), 'a failed archive must abort the save');
});
