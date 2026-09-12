import 'package:folio_core/folio_core.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

import '_sqlite.dart';

Database library() {
  final db = sqlite3.openInMemory();
  for (final s in schemaStatements) {
    db.execute(s);
  }
  db.execute('''INSERT INTO works (work_id, title, authors, chapter_count)
                VALUES ('1', 'Alpha', '["ann"]', 6)''');
  // a work nobody wrote a chapter count for, but whose chapters are here
  db.execute(
      "INSERT INTO works (work_id, title, authors) VALUES ('2', 'Bravo', '[\"bee\"]')");
  final ch =
      db.prepare('INSERT INTO chapters (work_id, number, html) VALUES (?,?,?)');
  ch.execute(['2', 1, '<p>one</p>']);
  ch.execute(['2', 2, '<p>two</p>']);
  return db;
}

List<String> inState(Database db, String state) {
  final q = buildWorksQuery({'state': state});
  return db.select(q.sql, q.args).map((r) => r['work_id'] as String).toList();
}

void main() {
  setUpAll(useSystemSqlite);

  test('a chapter completes by being left', () {
    final db = library();
    db.execute(saveProgressSql, ['1', 3, 0.0, 2]);
    expect(
        db.select('SELECT chapters_read FROM reading').first['chapters_read'],
        2,
        reason: 'reading chapter 3 means two are behind you');
    expect(inState(db, 'reading'), contains('1'));
    expect(inState(db, 'finished'), isNot(contains('1')));
  });

  test('progress never goes backwards on its own', () {
    final db = library();
    db.execute(saveProgressSql, ['1', 5, 0.0, 4]);
    // going back to re-read chapter two does not un-read the rest
    db.execute(saveProgressSql, ['1', 2, 0.0, 1]);
    final row = db.select('SELECT chapter, chapters_read FROM reading').first;
    expect(row['chapter'], 2,
        reason: 'the place moves, because that is where you are');
    expect(row['chapters_read'], 4,
        reason: 'but what you have read stays read');
  });

  test('finishing is an event, and it means what the library means by it', () {
    final db = library();
    db.execute(saveProgressSql, ['1', 6, 0.0, 5]);
    expect(inState(db, 'finished'), isNot(contains('1')),
        reason: 'the last chapter was never counted by reading it');

    db.execute(markFinishedSql, ['1']);
    expect(inState(db, 'finished'), contains('1'));
    expect(inState(db, 'reading'), isNot(contains('1')));
  });

  test('a work whose chapter count nobody knows can still be finished', () {
    final db = library();
    db.execute(markFinishedSql, ['2']);
    expect(inState(db, 'finished'), contains('2'),
        reason:
            'the chapters actually held answer it when the metadata cannot');
  });

  test('finishing can be taken back without losing the place', () {
    final db = library();
    db.execute(saveProgressSql, ['1', 6, 1840.0, 5]);
    db.execute(markFinishedSql, ['1']);
    db.execute(markUnfinishedSql, ['1']);
    final row =
        db.select('SELECT chapter, offset, chapters_read FROM reading').first;
    expect(inState(db, 'reading'), contains('1'));
    expect(row['chapter'], 6, reason: 'you are still where you were');
    expect(row['offset'], 1840.0);
  });

  test('opening a work is not the same as being somewhere in it', () async {
    final db = library();
    await markOpened(_Runner(db), '1');
    final row =
        db.select('SELECT chapter, offset, opened_at FROM reading').first;
    expect(row['opened_at'], isNotNull);
    expect(row['chapter'], isNull,
        reason: 'a peek from a search result must not move the bookmark');
    expect(inState(db, 'reading'), contains('1'),
        reason: 'but it is still reading, and belongs on the shelf');
  });

  group('where a chapter opens', () {
    test('where it was left off', () {
      expect(
          openingOffset(chapter: 3, savedChapter: 3, savedOffset: 1840), 1840);
    });
    test('and at the beginning when the saved place belongs to another chapter',
        () {
      expect(openingOffset(chapter: 4, savedChapter: 3, savedOffset: 1840), 0,
          reason: 'restoring it would land the reader in a chapter never seen');
    });
    test('a glance from a search result leaves no bookmark to return to', () {
      expect(
          openingOffset(
              chapter: 3, savedChapter: 3, savedOffset: 1840, transient: true),
          0);
    });
    test('and nonsense opens at the beginning', () {
      expect(openingOffset(chapter: 1, savedChapter: 1, savedOffset: -5), 0);
      expect(
          openingOffset(chapter: 1, savedChapter: null, savedOffset: null), 0);
      expect(
          openingOffset(chapter: 1, savedChapter: 1, savedOffset: double.nan),
          0);
    });
  });
}

class _Runner implements SqlRunner {
  _Runner(this.db);
  final Database db;
  @override
  Future<List<Map<String, Object?>>> query(String sql,
          [List<Object?> a = const []]) async =>
      db.select(sql, a).map((r) => {for (final k in r.keys) k: r[k]}).toList();
  @override
  Future<void> execute(String sql) async => db.execute(sql);
}
