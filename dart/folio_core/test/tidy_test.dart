import 'dart:convert';
import 'dart:io';

import 'package:folio_core/folio_core.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:test/test.dart';

import '_sqlite.dart';

/// Letting go of a work, and of an author, the way 1.x lets go of them.
///
/// The list and the order are the whole of a delete, and a rule about
/// collaborations is the whole of a block. Three implementations run them now
/// and none can import another's code, so `tools/emit-tidy-conformance.mjs`
/// records what the JavaScript says and this requires the same answers.
void main() {
  setUpAll(useSystemSqlite);

  final fixture =
      jsonDecode(File('test/conformance/tidy.json').readAsStringSync())
          as Map<String, Object?>;

  group('a work is not one row', () {
    test('the same tables, in the same order', () {
      expect(indexFirst, fixture['indexFirst']);
      expect(workOwns, fixture['workOwns']);
      expect(deleteStatements(), fixture['deleteStatements']);
      expect(tombstone, fixture['tombstone']);
    });

    test('and every one of them is emptied', () {
      /* Built with something in every table a work owns, so a table left out
         of the list is a row still sitting there when this is done. */
      final db = sqlite3.openInMemory();
      for (final statement in schemaStatements) {
        db.execute(statement);
      }

      db.execute('''
        INSERT INTO works (work_id, title, authors, words, chapter_count)
        VALUES ('1', 'Alpha', '["ann"]', 4200, 2), ('2', 'Bravo', '["bee"]', 9, 1)
      ''');
      db.execute('''
        INSERT INTO tags (work_id, kind, name)
        VALUES ('1', 'fandom', 'BTS'), ('2', 'fandom', 'EXO')
      ''');
      db.execute('''
        INSERT INTO chapters (work_id, number, title, html, text, words)
        VALUES ('1', 1, 'One', '<p>the first</p>', 'the first', 2000),
               ('1', 2, 'Two', '<p>the second</p>', 'the second', 2200),
               ('2', 1, 'One', '<p>elsewhere</p>', 'elsewhere', 9)
      ''');
      db.execute("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')");
      db.execute('''
        INSERT INTO work_fts (work_id, title, authors, summary, tags)
        VALUES ('1', 'Alpha', 'ann', '', 'BTS')
      ''');
      db.execute('''
        INSERT INTO chapter_versions (work_id, number, html, reason, archived_at)
        VALUES ('1', 1, '<p>an older first</p>', 'content', '2026-01-01')
      ''');
      db.execute('''
        INSERT INTO skin_versions (work_id, skin_css, archived_at)
        VALUES ('1', 'p { color: blue }', '2026-01-01')
      ''');
      db.execute('''
        INSERT INTO images (work_id, url, status)
        VALUES ('1', 'https://example.test/a.png', 'stored')
      ''');
      db.execute('''
        INSERT INTO reading (work_id, chapter, chapters_read) VALUES ('1', 2, 1)
      ''');

      // exactly what a backend runs, in the order it runs it
      final title = db.select(
        'SELECT title FROM works WHERE work_id = ?',
        ['1'],
      ).first['title'];
      db.execute('BEGIN');
      for (final row in db.select(
        'SELECT id FROM chapters WHERE work_id = ?',
        ['1'],
      )) {
        db.execute('DELETE FROM $indexFirst WHERE rowid = ?', [row['id']]);
      }
      for (final sql in deleteStatements()) {
        db.execute(sql, ['1']);
      }
      db.execute(tombstone, ['1', title]);
      db.execute('COMMIT');

      for (final table in workOwns) {
        expect(
          db.select('SELECT count(*) n FROM $table WHERE work_id = ?',
              ['1']).first['n'],
          0,
          reason: '$table still holds something belonging to a deleted work',
        );
      }

      /* The index goes first and by hand, because chapter_fts is external
         content keyed on chapters.rowid. Deleting the chapters first leaves
         rows pointing at nothing, and a search then finds a work that has
         been deleted and cannot open it. */
      expect(
        db
            .select(
                "SELECT count(*) n FROM chapter_fts WHERE chapter_fts MATCH 'first'")
            .first['n'],
        0,
        reason: 'the search index still answers for a work that is gone',
      );

      // and the tombstone, which is the half that makes it stay deleted
      final stone = db.select('SELECT * FROM deleted');
      expect(stone.length, 1);
      expect(stone.first['work_id'], '1');
      expect(stone.first['title'], 'Alpha');

      // the other work is untouched, which a delete taking too much would fail
      expect(db.select('SELECT count(*) n FROM works').first['n'], 1);
      expect(db.select('SELECT count(*) n FROM chapters').first['n'], 1);
      expect(db.select('SELECT count(*) n FROM tags').first['n'], 1);
    });
  });

  group('an author blocked is what is solely theirs hidden', () {
    for (final entry
        in (fixture['authors'] as List).cast<Map<String, Object?>>()) {
      final raw = entry['raw'];
      test('authors column ${jsonEncode(raw)}', () {
        expect(authorsOf(raw), entry['names']);
        for (final ask
            in (entry['hidden'] as List).cast<Map<String, Object?>>()) {
          final blocked = (ask['blocked'] as List).cast<String>();
          expect(
            isHidden(raw, blocked),
            ask['hidden'],
            reason: 'blocking $blocked disagrees with 1.x about this work',
          );
        }
      });
    }
  });

  group('a name only reaches the works it could be in', () {
    for (final entry
        in (fixture['patterns'] as List).cast<Map<String, Object?>>()) {
      final name = entry['name'] as String;
      test('"$name"', () => expect(worksByPattern(name), entry['pattern']));
    }
  });

  test('and the pattern matches what it should in real SQL', () {
    /* The escaping is the point. A name with a percent sign in it would
       otherwise match the whole library, and blocking one person would empty
       the shelves. */
    final db = sqlite3.openInMemory();
    db.execute('CREATE TABLE works (work_id TEXT, authors TEXT)');
    db.execute('''
      INSERT INTO works VALUES
        ('1', '["Anna"]'),
        ('2', '["Annabel"]'),
        ('3', '["Anna","bee"]'),
        ('4', '["100% Sure"]'),
        ('5', '["bee"]')
    ''');

    List<String> matching(String name) => db
        .select(
          "SELECT work_id FROM works WHERE authors LIKE ? ESCAPE '\\'",
          [worksByPattern(name)],
        )
        .map((row) => row['work_id'] as String)
        .toList();

    expect(matching('Anna'), ['1', '3'],
        reason: 'Annabel is a different person');
    expect(matching('Annabel'), ['2']);
    expect(matching('100% Sure'), ['4'],
        reason: 'a percent sign is a name, not a wildcard');
    expect(matching('nobody'), isEmpty);
  });
}
