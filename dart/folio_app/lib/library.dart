import 'dart:io';

import 'package:folio_core/folio_core.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

/// One work, as much of it as a list row needs.
class WorkRow {
  const WorkRow({
    required this.workId,
    required this.title,
    required this.authors,
    this.summary,
    this.words,
    this.chapterCount,
    this.fandom,
    this.hasText = false,
    this.skinCss,
  });

  factory WorkRow.fromMap(Map<String, Object?> row) => WorkRow(
    workId: '${row['work_id']}',
    title: row['title'] as String? ?? '(untitled)',
    authors: _namesFrom(row['authors'] as String?),
    summary: row['summary'] as String?,
    words: row['words'] as int?,
    chapterCount: row['chapter_count'] as int?,
    fandom: row['fandom'] as String?,
    hasText: (row['has_text'] as int? ?? 0) == 1,
    skinCss: row['skin_css'] as String?,
  );

  final String workId;
  final String title;
  final List<String> authors;
  final String? summary;
  final int? words;
  final int? chapterCount;
  final String? fandom;
  final bool hasText;
  final String? skinCss;

  String get byline => authors.isEmpty ? 'Anonymous' : authors.join(', ');
}

/// Authors are a JSON array in a text column. A work with several is ordinary.
List<String> _namesFrom(String? json) {
  if (json == null || json.isEmpty) return const [];
  // deliberately tolerant: an unreadable byline is not a reason to lose a work
  final matches = RegExp(r'"((?:[^"\\]|\\.)*)"').allMatches(json);
  return matches
      .map((m) => m.group(1)!.replaceAll(r'\"', '"').replaceAll(r'\\', r'\'))
      .toList();
}

/// The library file, and the questions asked of it.
///
/// 2.x opens the database 1.x wrote — same file, same schema, same migrations
/// — so an upgrade inherits a library in place rather than importing a copy of
/// one. Every query comes from folio_core, which is where they are tested.
class Library {
  Library._(this.db, this.path);

  final Database db;
  final String path;

  static const String fileName = 'archive.db';

  /// Where 1.x keeps it: the app's own files directory.
  static Future<String> defaultPath() async {
    final dir = await getApplicationSupportDirectory();
    return p.join(dir.path, fileName);
  }

  static Future<Library?> openExisting([String? at]) async {
    final path = at ?? await defaultPath();
    if (!File(path).existsSync()) return null;
    final db = await openDatabase(path);
    /* Whatever wrote this file, and whenever. A library is kept for years,
       backed up, carried between phones and opened by a version written long
       afterwards, so what is missing is added before anything is asked of
       it — a single absent column is not a missing shelf, it is the screen. */
    await prepare(_Runner(db));
    return Library._(db, path);
  }

  /// A library made here, for a device that has none yet.
  static Future<Library> create([String? at]) async {
    final path = at ?? await defaultPath();
    final db = await openDatabase(path);
    await prepare(_Runner(db));
    return Library._(db, path);
  }

  /// Take in a library from a 1.x backup.
  ///
  /// Copied rather than opened where it lies: a file handed over by the system
  /// picker may be a temporary the picker will delete, and the library is the
  /// one thing in this app that must not go missing. The copy becomes this
  /// app's own library and is brought up to date on the way in.
  static Future<Library> importFrom(String sourcePath, [String? at]) async {
    final destination = at ?? await defaultPath();
    await Directory(p.dirname(destination)).create(recursive: true);

    final existing = File(destination);
    if (existing.existsSync()) {
      /* Kept, not overwritten. Somebody importing over a library they have
         already read in is replacing it on purpose, and being wrong about
         that should cost them a rename rather than the library. */
      await existing.rename(
        '$destination.replaced-${DateTime.now().millisecondsSinceEpoch}',
      );
    }
    // the write-ahead log and its index belong to the file they were written
    // beside; carried over they describe a database that is no longer there
    for (final suffix in ['-wal', '-shm']) {
      final stale = File('$destination$suffix');
      if (stale.existsSync()) await stale.delete();
    }

    await File(sourcePath).copy(destination);
    final db = await openDatabase(destination);
    await prepare(_Runner(db));
    return Library._(db, destination);
  }

  Future<List<WorkRow>> works([Map<String, Object?> filters = const {}]) async {
    final q = buildWorksQuery(filters);
    final rows = await db.rawQuery(q.sql, q.args);
    return rows.map(WorkRow.fromMap).toList();
  }

  Future<int> count([Map<String, Object?> filters = const {}]) async {
    final q = buildWorksQuery(filters);
    final rows = await db.rawQuery(q.countSql, q.args);
    return (rows.first['n'] as int?) ?? 0;
  }

  /// One work, with what the reader needs to open it.
  Future<WorkRow?> work(String workId) async {
    final rows = await db.rawQuery(
      'SELECT work_id, title, authors, summary, words, chapter_count, has_text, skin_css '
      'FROM works WHERE work_id = ?',
      [workId],
    );
    return rows.isEmpty ? null : WorkRow.fromMap(rows.first);
  }

  Future<List<ChapterRow>> chapters(String workId) async {
    final rows = await db.rawQuery(
      'SELECT number, title FROM chapters WHERE work_id = ? ORDER BY number',
      [workId],
    );
    return rows
        .map((r) => ChapterRow(r['number'] as int, r['title'] as String?))
        .toList();
  }

  Future<String?> chapterHtml(String workId, int number) async {
    final rows = await db.rawQuery(
      'SELECT html FROM chapters WHERE work_id = ? AND number = ?',
      [workId, number],
    );
    return rows.isEmpty ? null : rows.first['html'] as String?;
  }

  /// Where the reader was in this work, if anywhere.
  Future<Place?> placeIn(String workId) async {
    final rows = await db.rawQuery(
      'SELECT chapter, offset, chapters_read FROM reading WHERE work_id = ?',
      [workId],
    );
    if (rows.isEmpty) return null;
    final row = rows.first;
    return Place(
      chapter: row['chapter'] as int?,
      offset: (row['offset'] as num?)?.toDouble(),
      chaptersRead: row['chapters_read'] as int? ?? 0,
    );
  }

  /// Opened, without saying where — a peek must not move the bookmark.
  Future<void> opened(String workId) => markOpened(_Runner(db), workId);

  /// Where in the work, and how far down the page.
  Future<void> savePlace(String workId, int chapter, double offset) =>
      db.rawInsert(saveProgressSql, [
        workId,
        chapter,
        offset,
        chapter - 1 < 0 ? 0 : chapter - 1,
      ]);

  Future<void> finish(String workId, {bool done = true}) => done
      ? db.rawInsert(markFinishedSql, [workId])
      : db.rawUpdate(markUnfinishedSql, [workId]);

  /// Every word held, ranked.
  ///
  /// The index is FTS4 over the chapter text, so the ranking is computed
  /// rather than asked for — see folio_core, where it is held to the scores
  /// 1.x gives the same blobs. SQLite returns matches in rowid order, so the
  /// candidate pool has to be wider than the answer or the best match for a
  /// common word is never considered at all.
  Future<List<Hit>> searchText(String query, {int limit = 40}) async {
    if (query.trim().isEmpty) return const [];
    final rows = await db.rawQuery(
      '''
      SELECT c.work_id, c.number, w.title, w.authors,
             snippet(chapter_fts, '<<', '>>', '…', -1, 24) AS snip,
             matchinfo(chapter_fts, 'pcnalx') AS matchinfo
      FROM chapter_fts
      JOIN chapters c ON c.id = chapter_fts.rowid
      JOIN works w ON w.work_id = c.work_id
      WHERE chapter_fts MATCH ? AND COALESCE(w.hidden, 0) = 0
      LIMIT ?''',
      [query, candidates],
    );

    return rank(rows, limit: limit)
        .map(
          (r) => Hit(
            workId: '${r['work_id']}',
            chapter: r['number'] as int? ?? 1,
            title: r['title'] as String? ?? '(untitled)',
            authors: _namesFrom(r['authors'] as String?),
            snippet: r['snip'] as String? ?? '',
          ),
        )
        .toList();
  }

  /// Titles, authors, summaries and tags — a different question from the text.
  Future<List<WorkRow>> searchMeta(String query, {int limit = 40}) async {
    if (query.trim().isEmpty) return const [];
    final rows = await db.rawQuery(
      '''
      SELECT w.work_id, w.title, w.authors, w.summary, w.words, w.chapter_count,
             w.has_text, w.skin_css,
             (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1) AS fandom
      FROM work_fts
      JOIN works w ON w.work_id = work_fts.work_id
      WHERE work_fts MATCH ? AND COALESCE(w.hidden, 0) = 0
      LIMIT ?''',
      [query, limit],
    );
    return rows.map(WorkRow.fromMap).toList();
  }

  Future<void> close() => db.close();
}

/// sqflite, wearing the interface folio_core asks for, so the migration can
/// be written and tested without a phone anywhere near it.
class _Runner implements SqlRunner {
  const _Runner(this.db);
  final Database db;

  @override
  Future<List<Map<String, Object?>>> query(
    String sql, [
    List<Object?> args = const [],
  ]) => db.rawQuery(sql, args);

  @override
  Future<void> execute(String sql) => db.execute(sql);
}

class ChapterRow {
  const ChapterRow(this.number, this.title);
  final int number;
  final String? title;
}

/// One passage found, and where it is.
class Hit {
  const Hit({
    required this.workId,
    required this.chapter,
    required this.title,
    required this.authors,
    required this.snippet,
  });

  final String workId;
  final int chapter;
  final String title;
  final List<String> authors;
  final String snippet;

  String get byline => authors.isEmpty ? 'Anonymous' : authors.join(', ');
}

/// Where somebody had got to.
class Place {
  const Place({this.chapter, this.offset, this.chaptersRead = 0});
  final int? chapter;
  final double? offset;
  final int chaptersRead;
}
