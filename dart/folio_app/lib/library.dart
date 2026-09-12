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
    final db = await openDatabase(path, readOnly: false);
    return Library._(db, path);
  }

  /// A library made here, for a device that has none yet.
  static Future<Library> create([String? at]) async {
    final path = at ?? await defaultPath();
    final db = await openDatabase(path);
    for (final statement in schemaStatements) {
      await db.execute(statement);
    }
    return Library._(db, path);
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

  Future<void> close() => db.close();
}

class ChapterRow {
  const ChapterRow(this.number, this.title);
  final int number;
  final String? title;
}
