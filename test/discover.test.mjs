import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { search, ftsQuery } from '../app/core/discover.js';
import { SCHEMA } from '../app/core/store/schema.js';

/**
 * A library whose text and metadata deliberately disagree.
 *
 * "Marlow" is an author's name and nothing else; "lighthouse" appears only in
 * prose. A scope that confuses the two is exactly the bug these scopes exist
 * to fix, so the fixture makes the confusion visible.
 */
function library() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const work = db.prepare(`INSERT INTO works
    (work_id, title, authors, summary, words, chapter_count, complete, rating, language)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const chapter = db.prepare(
    'INSERT INTO chapters (id, work_id, number, title, html, text, words) VALUES (?,?,?,?,?,?,?)');
  const tag = db.prepare('INSERT INTO tags (work_id, kind, name) VALUES (?,?,?)');

  work.run('1', 'Salt and Signal', '["marlow"]', 'A keeper counts ships.',
    900, 2, 1, 'Teen And Up Audiences', 'en');
  work.run('2', 'Inland', '["quill"]', 'Nobody here has seen the sea.',
    400, 1, 0, 'Explicit', 'en');

  chapter.run(1, '1', 1, 'One', '<p>x</p>', 'The lighthouse kept its own hours.', 6);
  chapter.run(2, '1', 2, 'Two', '<p>x</p>', 'She climbed the lighthouse stair again.', 6);
  chapter.run(3, '2', 1, 'One', '<p>x</p>', 'The lighthouse was a rumour told inland.', 7);

  tag.run('1', 'fandom', 'Original Work');
  tag.run('1', 'freeform', 'Lighthouse Keepers');
  tag.run('2', 'fandom', 'Original Work');

  db.exec(`INSERT INTO work_fts(rowid, work_id, title, authors, summary, tags)
           SELECT rowid, work_id, title, authors, summary, '' FROM works`);
  db.exec("INSERT INTO chapter_fts(rowid, text) SELECT id, text FROM chapters");
  return db;
}

const sql = (db) => (query, args = []) => db.prepare(query).all(...args);

test('a half-typed word matches by prefix; a deliberate query is left alone', () => {
  assert.equal(ftsQuery('light'), 'light*');
  assert.equal(ftsQuery('"lighthouse stair"'), '"lighthouse stair"');
  assert.equal(ftsQuery('salt AND signal'), 'salt AND signal');
});

test('the library searches metadata, not prose', () => {
  const db = library();
  const byAuthor = search(sql(db), 'marlow', 'meta');
  assert.deepEqual(byAuthor.works.map((w) => w.work_id), ['1']);
  // the word is in every chapter of both works and in neither's metadata
  assert.deepEqual(search(sql(db), 'lighthouse', 'meta').works, []);
});

test('a library search stays inside the filters already applied', () => {
  const db = library();
  db.prepare('UPDATE works SET rec = 1 WHERE work_id = ?').run('2');
  const all = search(sql(db), 'original OR sea OR ships', 'meta');
  const recs = search(sql(db), 'original OR sea OR ships', 'meta', { filters: { state: 'rec' } });
  assert.ok(all.works.length > recs.works.length);
  assert.deepEqual(recs.works.map((w) => w.work_id), ['2']);
});

test('searching inside a work never leaves it', () => {
  const db = library();
  const here = search(sql(db), 'lighthouse', 'work', { workId: '1' });
  assert.deepEqual([...new Set(here.hits.map((h) => h.work_id))], ['1']);
  assert.equal(here.hits.length, 2);
  // and the same query unscoped reaches the other work too
  assert.equal(search(sql(db), 'lighthouse', 'text').hits.length, 3);
});

test('a work search without a work is not a search of everything', () => {
  assert.deepEqual(search(sql(library()), 'lighthouse', 'work').hits, []);
});

test('discovery groups works, tags and passages', () => {
  const found = search(sql(library()), 'lighthouse', 'everything');
  assert.deepEqual(found.works.map((w) => w.work_id), []);   // no metadata match
  assert.deepEqual(found.tags.map((t) => t.name), ['Lighthouse Keepers']);
  assert.equal(found.hits.length, 3);
});

test('a tag is found by substring, since readers type the surname', () => {
  const found = search(sql(library()), 'keepers', 'everything');
  assert.deepEqual(found.tags.map((t) => t.name), ['Lighthouse Keepers']);
});

test('an empty query searches nothing rather than everything', () => {
  for (const scope of ['everything', 'meta', 'text', 'work']) {
    const out = search(sql(library()), '   ', scope, { workId: '1' });
    assert.deepEqual([out.hits, out.works, out.tags], [[], [], []]);
  }
});

test('discovery does not scan the corpus for a one-letter query', () => {
  const db = library();
  // "l" prefix-matches "lighthouse" in every chapter; works and tags still answer
  const brief = search(sql(db), 'li', 'everything');
  assert.deepEqual(brief.hits, []);
  assert.deepEqual(brief.tags.map((t) => t.name), ['Lighthouse Keepers']);
  // and the search tab, where full text is the whole point, still scans
  assert.equal(search(sql(db), 'li', 'text').hits.length, 3);
});
