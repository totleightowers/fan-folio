import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildWorksQuery, buildFacetQuery, buildColumnFacet, buildAuthorFacet, SORTS, STATES } from '../app/core/query.js';
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

test('a starred bookmark is filterable as a rec', () => {
  const db = library();
  db.prepare('UPDATE works SET rec = 1, in_bookmarks = 1 WHERE work_id = ?').run('2');
  db.prepare('UPDATE works SET in_history = 1 WHERE work_id = ?').run('3');
  assert.deepEqual(run(db, { state: 'rec' }), ['2']);
  assert.deepEqual(run(db, { state: 'bookmarked' }), ['2']);
  assert.deepEqual(run(db, { state: 'history' }), ['3']);
});

test('a work can be filtered to one author', () => {
  const db = library();
  assert.deepEqual(run(db, { author: 'bee' }), ['2']);
  assert.deepEqual(run(db, { author: 'ann' }), ['1']);
});

test('an author name does not match a longer one containing it', () => {
  const db = library();
  db.prepare('INSERT INTO works (work_id, title, authors) VALUES (?,?,?)')
    .run('4', 'Delta', '["annabel"]');
  // the quotes around the name in the stored JSON are what stop this
  assert.deepEqual(run(db, { author: 'ann' }), ['1']);
  assert.deepEqual(run(db, { author: 'annabel' }), ['4']);
});

test('a co-authored work is found under either name', () => {
  const db = library();
  db.prepare('INSERT INTO works (work_id, title, authors) VALUES (?,?,?)')
    .run('5', 'Echo', '["pineconepickers","tragicamente"]');
  assert.deepEqual(run(db, { author: 'pineconepickers' }), ['5']);
  assert.deepEqual(run(db, { author: 'tragicamente' }), ['5']);
});

test('a name carrying LIKE wildcards is matched literally', () => {
  const db = library();
  db.prepare('INSERT INTO works (work_id, title, authors) VALUES (?,?,?)')
    .run('6', 'Foxtrot', '["100%_real"]');
  assert.deepEqual(run(db, { author: '100%_real' }), ['6']);
  // unescaped, % and _ would make this match anything at all
  assert.deepEqual(run(db, { author: '1%' }), []);
});

test('a name with a quote in it is matched as stored', () => {
  const db = library();
  db.prepare('INSERT INTO works (work_id, title, authors) VALUES (?,?,?)')
    .run('7', 'Golf', JSON.stringify(['say "hi"']));
  assert.deepEqual(run(db, { author: 'say "hi"' }), ['7']);
});

test('authors combine with the other filters rather than replacing them', () => {
  const db = library();
  assert.deepEqual(run(db, { author: 'ann', rating: 'Explicit' }), ['1']);
  assert.deepEqual(run(db, { author: 'ann', rating: 'Teen And Up Audiences' }), []);
});

test('recently added sees a work fetched from the archive', () => {
  const db = library();
  /* Only the EPUB import ever set downloaded_at. A work fetched from the
     archive sets fetched_at, so ordering by downloaded_at alone put everything
     newly added at the very bottom of the shelf meant to show it. */
  db.prepare("UPDATE works SET downloaded_at = '2020-01-01' WHERE work_id = '1'").run();
  db.prepare("UPDATE works SET downloaded_at = NULL, fetched_at = '2026-08-28' WHERE work_id = '2'").run();
  assert.equal(run(db, { sort: 'added' })[0], '2', 'the one just fetched comes first');
});

test('works can be ranked by how the archive received them', () => {
  const db = library();
  const set = db.prepare('UPDATE works SET kudos = ?, bookmark_count = ?, hits = ? WHERE work_id = ?');
  set.run(100, 90, 1000, '1');
  set.run(500, 10, 9000, '2');
  set.run(300, 200, 500, '3');
  assert.deepEqual(run(db, { sort: 'kudos' }), ['2', '3', '1']);
  assert.deepEqual(run(db, { sort: 'bookmarks' }), ['3', '1', '2']);
  assert.deepEqual(run(db, { sort: 'hits' }), ['2', '1', '3']);
});

test('a work whose counts we have never seen ranks last, not first', () => {
  const db = library();
  db.prepare('UPDATE works SET kudos = 5 WHERE work_id = ?').run('1');
  // descending in SQLite puts NULL first, which would rank the uncounted top
  assert.equal(run(db, { sort: 'kudos' })[0], '1');
});

test('a work can be known without being held', () => {
  const db = library();
  db.prepare('UPDATE works SET has_text = 1 WHERE work_id IN (?,?)').run('1', '2');
  db.prepare('UPDATE works SET has_text = 0 WHERE work_id = ?').run('3');
  assert.deepEqual(run(db, { state: 'held' }), ['1', '2']);
  assert.deepEqual(run(db, { state: 'known' }), ['3']);
});

test('a work described from a listing still filters by its tags', () => {
  /* The point of describing thousands of works for nothing is that they can be
     found. A stub that cannot be filtered is a row taking up space. */
  const db = library();
  db.prepare('UPDATE works SET has_text = 0').run();
  assert.deepEqual(run(db, { state: 'known', include: 'BTS' }), ['1', '2']);
});

/*
 * A rating is one value per work, kept in a column rather than in the tags
 * table. The filter panel builds its counts by looping over the tag kinds, so
 * ratings were never counted — and a section that draws itself only when it
 * has counts drew itself never. The filter behind it worked the whole time.
 */
test('rating and language can be counted, so their sections can appear', () => {
  for (const column of ['rating', 'language']) {
    const q = buildColumnFacet({ state: 'all' }, column);
    assert.match(q.sql, new RegExp(`w\\.${column} AS name`));
    assert.match(q.sql, /count\(\*\) AS n/);
    assert.match(q.sql, new RegExp(`GROUP BY w\\.${column}`));
  }
  assert.throws(() => buildColumnFacet({}, 'summary'), /unknown column facet/,
    'only the columns meant to be counted, never one spliced in by a caller');
});

test('choosing a rating does not hide the other ratings from the list', () => {
  const all = buildColumnFacet({ state: 'all' }, 'rating');
  const one = buildColumnFacet({ state: 'all', rating: ['Explicit'] }, 'rating');
  assert.equal(one.sql, all.sql, 'the column being chosen is left out of its own counts');
  assert.deepEqual(one.args, all.args);
});

test('the archive filters this library did not have', () => {
  const since = buildWorksQuery({ updatedAfter: '2025-01-01' });
  assert.match(since.countSql, /COALESCE\(w\.updated, w\.published\) >= \?/);
  assert.ok(since.args.includes('2025-01-01'));

  const cross = buildWorksQuery({ crossover: '1' });
  assert.match(cross.countSql, /count\(DISTINCT t\.name\)[\s\S]*fandom'\) > 1/);
  const single = buildWorksQuery({ crossover: '0' });
  assert.match(single.countSql, /fandom'\) <= 1/);

  const chapters = buildWorksQuery({ chaptersMin: 2, chaptersMax: 10 });
  assert.match(chapters.countSql, /w\.chapter_count >= \?/);
  assert.match(chapters.countSql, /w\.chapter_count <= \?/);
});

/*
 * Choosing a relationship gives every work carrying it among others, which for
 * a popular pair is most of a fandom. What is usually meant is the works that
 * are about it.
 */
test('only this pairing means no other relationship on the work', () => {
  const q = buildWorksQuery({ include: ['A/B'], otp: '1' });
  assert.match(q.countSql, /NOT EXISTS[\s\S]*kind = 'relationship'[\s\S]*NOT IN/);
  assert.ok(q.args.includes('A/B'), 'the chosen tags are what it is exact about');
});

test('only this pairing with nothing chosen does nothing', () => {
  const bare = buildWorksQuery({ otp: '1' });
  assert.ok(!/kind = 'relationship'/.test(bare.countSql),
    'otherwise it asks for works with no relationships at all, which is not what anyone meant');
  assert.deepEqual(bare.countSql, buildWorksQuery({}).countSql);
});

test('authors can be counted, so they can be chosen as well as removed', () => {
  const q = buildAuthorFacet({ state: 'all' }, 12);
  assert.match(q.sql, /json_each\(w\.authors\)/, 'authors are a JSON array, not tag rows');
  assert.match(q.sql, /LIMIT 12/, 'a top handful, with the rest behind a button');
  const chosen = buildAuthorFacet({ state: 'all', author: ['someone'] }, 12);
  assert.equal(chosen.sql, q.sql, 'picking one author does not hide the others');
});
