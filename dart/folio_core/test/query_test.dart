import 'package:folio_core/folio_core.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

import '_sqlite.dart';

/// A small library with known contents, so counts can be asserted exactly.
///
/// The same fixture as `test/query.test.mjs`, deliberately: two ports of one
/// query builder answering different questions about the same three works
/// would tell us nothing about whether they agree.
Database library() {
  final db = sqlite3.openInMemory();
  for (final statement in schemaStatements) {
    db.execute(statement);
  }

  final work = db.prepare('''INSERT INTO works
    (work_id, title, authors, words, chapter_count, complete, rating, language, published)
    VALUES (?,?,?,?,?,?,?,?,?)''');
  final tag =
      db.prepare('INSERT INTO tags (work_id, kind, name) VALUES (?,?,?)');
  final read = db.prepare(
      'INSERT INTO reading (work_id, chapter, chapters_read, marked_later) VALUES (?,?,?,?)');

  work.execute(
      ['1', 'Alpha', '["ann"]', 1000, 5, 1, 'Explicit', 'en', '2020-01-01']);
  work.execute([
    '2',
    'Bravo',
    '["bee"]',
    50000,
    10,
    0,
    'Teen And Up Audiences',
    'en',
    '2021-01-01'
  ]);
  work.execute(
      ['3', 'Charlie', '["cee"]', 5000, 3, 1, 'Explicit', 'fr', '2022-01-01']);

  tag
    ..execute(['1', 'fandom', 'BTS'])
    ..execute(['1', 'freeform', 'Fluff']);
  tag
    ..execute(['2', 'fandom', 'BTS'])
    ..execute(['2', 'freeform', 'Angst']);
  tag
    ..execute(['3', 'fandom', 'EXO'])
    ..execute(['3', 'freeform', 'Fluff']);

  read.execute(['1', 5, 1, 0]); // part read
  read.execute(['3', 1, 0, 1]); // marked for later, unread
  return db;
}

List<String> run(Database db, [Map<String, Object?> filters = const {}]) {
  final q = buildWorksQuery(filters);
  return db
      .select(q.sql, q.args)
      .map((row) => row['work_id'] as String)
      .toList();
}

void main() {
  setUpAll(useSystemSqlite);

  test('the schema this builds against is the one the app ships', () {
    final db = library();
    final tables = db
        .select("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((r) => r['name'] as String)
        .toSet();
    for (final needed in [
      'works',
      'tags',
      'chapters',
      'reading',
      'meta',
      'deleted',
      'blocked',
      'bookmarked_by'
    ]) {
      expect(tables, contains(needed));
    }
  });

  test('reading state filters use the reading table', () {
    final db = library();
    expect(run(db, {'state': 'reading'}), ['1']);
    expect(run(db, {'state': 'later'}), ['3']);
    expect(run(db, {'state': 'unread'}), ['2', '3']);
  });

  test('a saved place in chapter one is reading, however it was recorded', () {
    final db = library();
    db.execute(
        '''INSERT INTO works (work_id, title, authors, words, chapter_count, complete)
                  VALUES ('4', 'Delta', '["dee"]', 2000, 4, 0)''');
    db.execute(
        '''INSERT INTO works (work_id, title, authors, words, chapter_count, complete)
                  VALUES ('5', 'Echo', '["eee"]', 2000, 4, 0)''');
    // partway down chapter one of a library carried over from an older app
    db.execute(
        '''INSERT INTO reading (work_id, chapter, offset, chapters_read, opened_at)
                  VALUES ('4', 1, 1840, 0, NULL)''');
    // opened here, not yet scrolled
    db.execute(
        '''INSERT INTO reading (work_id, chapter, offset, chapters_read, opened_at)
                  VALUES ('5', 1, 0, 0, '2026-01-01')''');

    expect(run(db, {'state': 'reading'}), ['1', '4', '5']);
    expect(run(db, {'state': 'unread'}), ['2', '3']);
  });

  test('a work whose text is not here yet is not a work you have finished', () {
    final db = library();
    // a stub: described by a listing, never downloaded. count(*) over no rows
    // is 0 rather than NULL, so a single COALESCE gave it a total of nought —
    // and "chapters read >= 0" is true of every work there has ever been.
    db.execute(
        '''INSERT INTO works (work_id, title, authors, chapter_count, complete)
                  VALUES ('7', 'Golf', '["gee"]', NULL, 0)''');

    expect(run(db, {'state': 'finished'}), isNot(contains('7')));
    expect(run(db, {'state': 'unread'}), contains('7'));

    db.execute(
        "INSERT INTO reading (work_id, opened_at) VALUES ('7', '2026-01-01')");
    expect(run(db, {'state': 'reading'}), contains('7'));
  });

  test('every work is in exactly one reading state', () {
    final db = library();
    final all = run(db)..sort();
    final seen = [
      ...run(db, {'state': 'reading'}),
      ...run(db, {'state': 'unread'}),
      ...run(db, {'state': 'finished'}),
    ]..sort();
    expect(seen, all);
  });

  test('a work only a blocked author wrote is not in the library at all', () {
    final db = library();
    db.execute("UPDATE works SET hidden = 1 WHERE work_id = '2'");
    for (final state in [
      'all',
      'reading',
      'unread',
      'finished',
      'later',
      'held',
      'known'
    ]) {
      expect(run(db, {'state': state}), isNot(contains('2')),
          reason: 'state=$state');
    }
    expect(
        run(db, {
          'include': ['Angst']
        }),
        isNot(contains('2')));
    expect(
        run(db, {
          'author': ['bee']
        }),
        isNot(contains('2')));
    expect(
        run(db, {
          'ids': ['1', '2', '3']
        }),
        isNot(contains('2')));
  });

  test('an author matches their own name and not a longer one containing it',
      () {
    final db = library();
    db.execute(
        '''INSERT INTO works (work_id, title, authors) VALUES ('8', 'Hotel', '["annabel"]')''');
    expect(
        run(db, {
          'author': ['ann']
        }),
        ['1'],
        reason: 'the quotes are what stop it');
    expect(
        run(db, {
          'author': ['annabel']
        }),
        ['8']);
  });

  test("a person's bookmarks are a different question from their works", () {
    final db = library();
    final noted = db.prepare(
        'INSERT INTO bookmarked_by (person, work_id, at) VALUES (?,?,?)');
    noted.execute(['ann', '2', '2026-01-01']);
    noted.execute(['ann', '3', '2026-01-01']);

    expect(run(db, {'bookmarkedBy': 'ann'}), ['2', '3']);
    expect(
        run(db, {
          'author': ['ann']
        }),
        ['1']);
    expect(run(db, {'bookmarkedBy': 'nobody'}), isEmpty);
  });

  test('the count agrees with the list', () {
    final db = library();
    final q = buildWorksQuery({});
    final counted = db.select(q.countSql, q.args).first['n'] as int;
    expect(counted, run(db).length);
  });

  test('nothing a reader types reaches the SQL unbound', () {
    final db = library();
    // the shape of an injection attempt, which must simply match nothing
    final nasty = "'; DROP TABLE works; --";
    expect(
        run(db, {
          'author': [nasty],
          'include': [nasty],
          'language': nasty
        }),
        isEmpty);
    expect(db.select('SELECT count(*) AS n FROM works').first['n'], 3,
        reason: 'the table is still there');
  });
}
