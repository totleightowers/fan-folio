import 'package:folio_core/folio_core.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

import '_sqlite.dart';

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

Database library() {
  final db = sqlite3.openInMemory();
  for (final s in schemaStatements) {
    db.execute(s);
  }
  return db;
}

void main() {
  setUpAll(useSystemSqlite);

  test('a setup survives the round trip', () async {
    const chosen = ReadingPrefs(
      size: 22,
      lineHeight: 1.9,
      face: ReadingFace.atkinson,
      margin: 32,
      justified: true,
      theme: ReadingTheme.sepia,
    );
    final db = library();
    final write = db.prepare('INSERT INTO meta (key, value) VALUES (?,?)');
    chosen.toMap().forEach((k, v) => write.execute([k, v]));

    final back = await loadPrefs(_Runner(db));
    expect(back.size, 22);
    expect(back.lineHeight, 1.9);
    expect(back.face, ReadingFace.atkinson);
    expect(back.margin, 32);
    expect(back.justified, isTrue);
    expect(back.theme, ReadingTheme.sepia);
  });

  test('a reader with no saved setup gets a readable one', () async {
    final back = await loadPrefs(_Runner(library()));
    expect(back.size, 19);
    expect(back.face, ReadingFace.literata);
    expect(back.theme, ReadingTheme.system);
  });

  test('a library from before this existed is not an error', () async {
    final db = sqlite3.openInMemory();
    db.execute('CREATE TABLE works (work_id TEXT)');
    expect((await loadPrefs(_Runner(db))).size, 19,
        reason: 'no meta table is a reader with no setup, not a broken app');
  });

  test('nonsense is clamped rather than obeyed', () {
    /* A stored setting is a number somebody's finger chose on a slider, and a
       number a future version may not have meant. Nine-point type and a line
       height of forty are both a chapter nobody can read. */
    final wild = ReadingPrefs.fromMap({
      'read.size': '900',
      'read.lineHeight': '0.1',
      'read.margin': '-40',
      'read.face': 'a face that does not exist',
      'read.theme': 'chartreuse',
    });
    expect(wild.size, 34);
    expect(wild.lineHeight, 1.1);
    expect(wild.margin, 0);
    expect(wild.face, ReadingFace.literata,
        reason: 'a name the app cannot keep');
    expect(wild.theme, ReadingTheme.system);
  });

  test('an unreadable number falls back rather than becoming NaN', () {
    final broken = ReadingPrefs.fromMap({'read.size': 'nineteen'});
    expect(broken.size, 19);
  });
}
