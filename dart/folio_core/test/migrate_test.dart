import 'package:folio_core/folio_core.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

import '_sqlite.dart';

/// sqlite3, wearing the interface folio_core asks for.
class _Runner implements SqlRunner {
  _Runner(this.db);
  final Database db;

  @override
  Future<List<Map<String, Object?>>> query(String sql,
          [List<Object?> args = const []]) async =>
      db
          .select(sql, args)
          .map((r) => {for (final k in r.keys) k: r[k]})
          .toList();

  @override
  Future<void> execute(String sql) async => db.execute(sql);
}

/// A library as it was before any of this year's columns.
///
/// This is what is actually on a phone: a file somebody kept, backed up, and
/// carried to a version written months later.
Database oldLibrary() {
  final db = sqlite3.openInMemory();
  db.execute('''
    CREATE TABLE works (
      work_id TEXT PRIMARY KEY, title TEXT, authors TEXT, summary TEXT,
      rating TEXT, language TEXT, published TEXT, updated TEXT,
      downloaded_at TEXT, complete INTEGER, words INTEGER,
      chapter_count INTEGER, chapters_planned INTEGER, updated_at INTEGER,
      skin_css TEXT, skin_hash TEXT, end_notes_html TEXT,
      source TEXT, source_file TEXT, fetched_at TEXT);
    CREATE TABLE reading (work_id TEXT PRIMARY KEY, chapter INTEGER,
      chapters_read INTEGER, marked_later INTEGER);
    CREATE TABLE tags (work_id TEXT, kind TEXT, name TEXT);
    CREATE TABLE chapters (id INTEGER PRIMARY KEY, work_id TEXT, number INTEGER, html TEXT);
  ''');
  db.execute(
      "INSERT INTO works (work_id, title, complete) VALUES ('1', 'Alpha', 1)");
  return db;
}

void main() {
  setUpAll(useSystemSqlite);

  test('a library from before this year still opens', () async {
    final db = oldLibrary();
    final added = await prepare(_Runner(db));

    // rec is the column whose absence took out the whole library screen once
    expect(added, contains('rec'));
    expect(added, contains('hidden'));
    expect(added, contains('has_text'));
    // and the reading table, not only works: what is being read now asks it
    // for offset and opened_at, and a library lacking either answered
    // "no such column" — which is not a missing shelf, it is the screen
    expect(added, contains('opened_at'));
    expect(added, contains('offset'));

    final q = buildWorksQuery({});
    expect(db.select(q.sql, q.args).map((r) => r['work_id']), ['1']);
  });

  test('the tables added since arrive too', () async {
    final db = oldLibrary();
    await prepare(_Runner(db));
    final tables = db
        .select("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((r) => r['name'] as String)
        .toSet();
    for (final needed in ['deleted', 'blocked', 'bookmarked_by', 'meta']) {
      expect(tables, contains(needed), reason: '$needed is missing');
    }
  });

  test('it is safe to run on every open', () async {
    final db = oldLibrary();
    await prepare(_Runner(db));
    expect(await prepare(_Runner(db)), isEmpty,
        reason: 'a library is opened every time the app starts');
  });

  test('a current library is left completely alone', () async {
    final db = sqlite3.openInMemory();
    for (final statement in schemaStatements) {
      db.execute(statement);
    }
    expect(await ensureColumns(_Runner(db)), isEmpty);
  });

  test('every reading state can be asked of a migrated library', () async {
    final db = oldLibrary();
    await prepare(_Runner(db));
    for (final state in [
      'all',
      'reading',
      'unread',
      'finished',
      'later',
      'held',
      'known',
      'bookmarked',
      'history',
      'rec'
    ]) {
      final q = buildWorksQuery({'state': state});
      expect(() => db.select(q.sql, q.args), returnsNormally,
          reason: 'state=$state');
    }
  });
}
