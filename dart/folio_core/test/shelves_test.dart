import 'package:folio_core/folio_core.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

import '_sqlite.dart';

Database library() {
  final db = sqlite3.openInMemory();
  for (final s in schemaStatements) {
    db.execute(s);
  }
  final work = db.prepare('''INSERT INTO works
    (work_id, title, authors, words, chapter_count, complete, downloaded_at)
    VALUES (?,?,?,?,?,?,?)''');
  work.execute(['1', 'Alpha', '["ann"]', 90000, 30, 1, '2026-01-01']);
  work.execute(['2', 'Bravo', '["bee"]', 3000, 1, 1, '2026-02-01']);
  work.execute(['3', 'Charlie', '["cee"]', 40000, 8, 0, '2026-03-01']);
  db.execute("INSERT INTO reading (work_id, chapter, chapters_read, opened_at) "
      "VALUES ('3', 2, 1, '2026-03-02')");
  db.execute("INSERT INTO reading (work_id, marked_later) VALUES ('1', 1)");
  return db;
}

List<String> onShelf(Database db, String key) {
  final shelf = shelves().firstWhere((s) => s.key == key);
  return db.select(shelf.sql()).map((r) => r['work_id'] as String).toList();
}

void main() {
  setUpAll(useSystemSqlite);

  test('what somebody came back for is the first shelf', () {
    expect(shelves().first.key, 'reading',
        reason: 'carrying on with a work is why anybody opens a reading app');
  });

  test('each shelf holds what it says it holds', () {
    final db = library();
    expect(onShelf(db, 'reading'), ['3']);
    expect(onShelf(db, 'later'), ['1']);
    expect(onShelf(db, 'added'), ['3', '2', '1'], reason: 'newest first');
    /* Everything complete and unstarted, longest first — there is no minimum
       length, so a short one is on it too, at the bottom where it belongs. */
    expect(onShelf(db, 'long'), ['1', '2'],
        reason: 'complete, unstarted, longest first');
    expect(onShelf(db, 'short'), ['2'],
        reason: 'complete, unstarted, under 5,000');
  });

  test('a blocked author is off every shelf, not just the library', () {
    /* Home builds its shelves by hand rather than through the query builder,
       and the two disagreeing is how a hidden work ends up offered on the
       front page of the app that is hiding it. */
    final db = library();
    db.execute('UPDATE works SET hidden = 1');
    for (final shelf in shelves()) {
      expect(db.select(shelf.sql()), isEmpty, reason: shelf.key);
      expect(db.select(shelf.countSql).first['n'], 0, reason: shelf.key);
    }
  });

  test('a shelf can say how much of it is not on it', () {
    final db = library();
    final added = shelves().firstWhere((s) => s.key == 'added');
    expect(db.select(added.countSql).first['n'], 3);
    expect(db.select(added.sql(limit: 2)).length, 2,
        reason: 'and the count is of the whole shelf, not of what fits on it');
  });

  test('See all asks the shelf\'s own question', () {
    /* "Settle in" is long, complete and unstarted. Landing on the whole
       library sorted by length is a different set of works, most of it
       neither complete nor unstarted. */
    final long = shelves().firstWhere((s) => s.key == 'long');
    expect(long.view['state'], 'unread');
    expect(long.view['complete'], '1');

    final db = library();
    final q = buildWorksQuery(long.view);
    expect(
        db.select(q.sql, q.args).map((r) => r['work_id']), onShelf(db, 'long'));
  });

  test('the counts are of what is shown', () {
    final db = library();
    final stats = db.select(statsSql).first;
    expect(stats['works'], 3);
    expect(stats['later'], 1);

    db.execute("UPDATE works SET hidden = 1 WHERE work_id = '1'");
    expect(db.select(statsSql).first['works'], 2,
        reason:
            'a count including what the library hides is a library that looks broken');
  });
}
