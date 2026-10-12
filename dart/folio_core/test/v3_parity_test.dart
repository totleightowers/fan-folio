import 'package:folio_core/folio_core.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';
import '_sqlite.dart';

void main() {
  setUpAll(useSystemSqlite);
  late Database db;
  setUp(() {
    db = sqlite3.openInMemory();
    for (final sql in schemaStatements) {
      db.execute(sql);
    }
    db.execute(
        "INSERT INTO works (work_id,title,chapter_count,has_text,visits) VALUES ('1','One',2,0,10),('2','Two',1,1,12),('3','Three',1,0,NULL)");
    db.execute(
        "INSERT INTO chapters (work_id,number,html) VALUES ('1',1,'<p>Saved from EPUB</p>'),('1',2,'<p>End</p>')");
    db.execute(
        "INSERT INTO reading (work_id,chapter,offset,chapters_read,opened_at) VALUES ('1',2,90,2,'2026-10-12')");
  });
  tearDown(() => db.dispose());
  List<String> works(Map<String, Object?> view) {
    final q = buildWorksQuery(view);
    return db
        .select(q.sql, q.args)
        .map((row) => row['work_id'] as String)
        .toList();
  }

  test(
      'held text wins over stale flags, availability combines with reading state',
      () {
    expect(works({'availability': 'held'}), ['1']);
    expect(works({'state': 'held'}), ['1']);
    expect(works({'state': 'finished', 'availability': 'held'}), ['1']);
    expect(works({'state': 'unread', 'availability': 'held'}), isEmpty);
    expect(works({'availability': 'known'}), ['3', '2']);
  });
  test('rereading retains previous completion and all Continue routes agree',
      () {
    db.execute(restartReadingSql, ['1']);
    final r = db.select("SELECT * FROM reading WHERE work_id='1'").single;
    expect(r['chapter'], 1);
    expect(r['offset'], 0);
    expect(r['chapters_read'], 0);
    expect(r['completed_before'], 1);
    expect(works({'state': 'reading'}), ['1']);
    expect(works({'state': 'finished'}), ['1']);
    final shelf = shelves().firstWhere((s) => s.key == 'reading');
    expect(db.select(shelf.sql()).single['work_id'], '1');
    expect(db.select(readStatsSql).single['finished'], 1);
    db.execute(saveProgressSql, ['1', 1, 24, 0]);
    expect(works({'state': 'finished'}), ['1']);
  });
  test(
      'AO3 snapshot plus distinct local visits sorts and repeated saves do not count',
      () {
    for (final id in ['a', 'b', 'c', 'c']) {
      db.execute(recordVisitSql, [id, '1']);
    }
    expect(works({'sort': 'visits'}), ['1', '2', '3']);
    final q = buildWorksQuery({'sort': 'visits'});
    final row = db.select(q.sql, q.args).first;
    expect(row['visits'], 10);
    expect(row['ff_visits'], 3);
    db.execute(saveProgressSql, ['1', 2, 20, 1]);
    expect(db.select('SELECT count(*) n FROM reading_visits').single['n'], 3);
  });
  test('newly imported old copies appear before older library acquisitions',
      () {
    db.execute(
        "UPDATE works SET downloaded_at='2000-01-01',fetched_at='2026-10-12' WHERE work_id='1'");
    db.execute(
        "UPDATE works SET downloaded_at='2025-01-01',fetched_at='2025-01-01' WHERE work_id='2'");
    expect(works({'sort': 'added'}).first, '1');
    expect(
        db
            .select(shelves().firstWhere((s) => s.key == 'added').sql())
            .first['work_id'],
        '1');
  });
}
