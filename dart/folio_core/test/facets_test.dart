import 'package:folio_core/folio_core.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

import '_sqlite.dart';

Database library() {
  final db = sqlite3.openInMemory();
  for (final s in schemaStatements) {
    db.execute(s);
  }
  final work = db.prepare(
    'INSERT INTO works (work_id, title, authors, rating, language, complete) VALUES (?,?,?,?,?,?)',
  );
  final tag =
      db.prepare('INSERT INTO tags (work_id, kind, name) VALUES (?,?,?)');

  work.execute(['1', 'Alpha', '["ann"]', 'Explicit', 'en', 1]);
  work.execute(
      ['2', 'Bravo', '["bee","ann"]', 'Teen And Up Audiences', 'en', 0]);
  work.execute(['3', 'Charlie', '["cee"]', 'Explicit', 'fr', 1]);

  tag.execute(['1', 'fandom', 'BTS']);
  tag.execute(['1', 'freeform', 'Fluff']);
  tag.execute(['2', 'fandom', 'BTS']);
  tag.execute(['2', 'freeform', 'Angst']);
  tag.execute(['3', 'fandom', 'EXO']);
  tag.execute(['3', 'freeform', 'Fluff']);
  return db;
}

Map<String, int> counts(Database db, FacetQuery q) => {
      for (final row in db.select(q.sql, q.args))
        row['name'] as String: row['n'] as int,
    };

void main() {
  setUpAll(useSystemSqlite);

  test('a facet counts against what is already narrowed', () {
    final db = library();
    expect(counts(db, tagFacet({}, 'fandom')), {'BTS': 2, 'EXO': 1});

    /* The point of counting this way: the panel shows what narrowing further
       would actually leave, so nobody picks a combination that yields
       nothing. Choosing EXO must not go on offering Fluff-with-BTS. */
    expect(
        counts(
            db,
            tagFacet({
              'include': ['EXO']
            }, 'freeform')),
        {'Fluff': 1});
  });

  test('a rating is counted even though it is not a tag', () {
    /* The facets were built by looping over tag kinds, so ratings were never
       counted — and the panel draws its Rating section only when it has
       counts, which is to say never. The filter behind it worked the whole
       time; there was simply no way to reach it. */
    final db = library();
    expect(counts(db, columnFacet({}, 'rating')),
        {'Explicit': 2, 'Teen And Up Audiences': 1});
    expect(counts(db, columnFacet({}, 'language')), {'en': 2, 'fr': 1});
  });

  test('choosing a rating does not remove it from the list you chose it from',
      () {
    final db = library();
    final narrowed = counts(
        db,
        columnFacet({
          'rating': ['Explicit']
        }, 'rating'));
    expect(narrowed.containsKey('Teen And Up Audiences'), isTrue,
        reason: 'the column being filtered on is dropped from its own counts');
  });

  test('authors are counted out of the JSON array they live in', () {
    final db = library();
    expect(counts(db, authorFacet({})), {'ann': 2, 'bee': 1, 'cee': 1});
  });

  test('searching a facet reaches past the handful on screen', () {
    /* A library holds far more names than anyone will scroll, so the panel
       shows the busiest few — and a search that sifted only those could not
       find the rest at all. */
    final db = library();
    expect(counts(db, authorFacet({}, limit: 1)).length, 1);
    expect(counts(db, authorFacet({}, needle: 'cee')), {'cee': 1},
        reason: 'found even though it is not in the top one');
    expect(counts(db, tagFacet({}, 'freeform', limit: 1, needle: 'Ang')),
        {'Angst': 1});
  });

  test('a blocked author is not offered as something to filter by', () {
    final db = library();
    db.execute("UPDATE works SET hidden = 1 WHERE work_id = '3'");
    expect(counts(db, tagFacet({}, 'fandom')), {'BTS': 2});
    expect(counts(db, columnFacet({}, 'language')), {'en': 2});
    expect(counts(db, authorFacet({})).containsKey('cee'), isFalse,
        reason: 'a name offered in a filter panel is a name the library shows');
  });

  test('an unknown facet is refused rather than guessed at', () {
    expect(() => tagFacet({}, 'nonsense'), throwsArgumentError);
    expect(() => columnFacet({}, 'nonsense'), throwsArgumentError);
  });
}
