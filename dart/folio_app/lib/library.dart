import 'dart:io';
import 'dart:typed_data';

import 'package:folio_core/folio_core.dart';
import 'package:folio_core/folio_core.dart' as core;
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
    this.rating,
    this.language,
    this.complete,
    this.published,
    this.updated,
    this.kudos,
    this.hits,
    this.bookmarkCount,
    this.inBookmarks = false,
    this.kudosGiven = false,
    this.markedLater = false,
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
    /* Only present when the row was asked for in full. A list does not need
       them and a work's own page does, so both read the same class and the
       page asks the wider question. */
    rating: row['rating'] as String?,
    language: row['language'] as String?,
    complete: row.containsKey('complete') && row['complete'] != null
        ? row['complete'] == 1
        : null,
    published: row['published'] as String?,
    updated: row['updated'] as String?,
    kudos: row['kudos'] as int?,
    hits: row['hits'] as int?,
    bookmarkCount: row['bookmark_count'] as int?,
    inBookmarks: (row['in_bookmarks'] as int? ?? 0) == 1,
    kudosGiven: (row['kudos_given'] as int? ?? 0) == 1,
    markedLater: (row['marked_later'] as int? ?? 0) == 1,
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

  final String? rating;
  final String? language;

  /// Null when nobody asked. A work whose completeness is unknown is not a
  /// work in progress, and saying so either way would be inventing it.
  final bool? complete;

  final String? published;
  final String? updated;
  final int? kudos;
  final int? hits;
  final int? bookmarkCount;
  final bool inBookmarks;
  final bool kudosGiven;
  final bool markedLater;

  String get byline => authors.isEmpty ? 'Anonymous' : authors.join(', ');

  /// The line under a card: what it is, how long, and whether it is here.
  String get facts => [
    if (fandom != null) fandom!,
    if (words != null) '${_thousands(words!)} words',
    if (chapterCount != null && chapterCount! > 1) '$chapterCount chapters',
    if (!hasText) 'not downloaded',
  ].join(' · ');
}

/// Thousands separated, because a number nobody can read at a glance is not
/// doing the job a number is there to do.
String _thousands(int n) {
  final digits = '$n';
  final out = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) out.write(',');
    out.write(digits[i]);
  }
  return out.toString();
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
  /// Take in a library from a backup.
  ///
  /// A stream rather than a path, because a file handed over by the system
  /// picker on Android often has no path at all — it is a content:// URI the
  /// picker will resolve and may later revoke — and because a library big
  /// enough to be worth keeping is too big to read into memory on the way in.
  ///
  /// Written to this app's own storage rather than opened where it lies: the
  /// library is the one thing in this app that must not go missing.
  static Future<Library> importFromStream(
    Stream<List<int>> bytes, [
    String? at,
  ]) async {
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

    final out = File(destination).openWrite();
    try {
      await out.addStream(bytes);
    } finally {
      await out.close();
    }

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
  /// One work, as much of it as its own page needs.
  Future<WorkRow?> work(String workId) async {
    final rows = await db.rawQuery(
      '''
      SELECT w.*, r.marked_later,
             (SELECT name FROM tags t
               WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1)
               AS fandom
      FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
      WHERE w.work_id = ?''',
      [workId],
    );
    return rows.isEmpty ? null : WorkRow.fromMap(rows.first);
  }

  /// Every tag on a work, by kind, in the order the archive lists them.
  Future<Map<String, List<String>>> tagsFor(String workId) async {
    /* Not ORDER BY rowid: the tags table is WITHOUT ROWID, so asking for one
       is an error rather than an ordering, and it took the whole screen down
       with it. The archive's own order is not recoverable from here anyway —
       the primary key is what the rows are stored by, so that is the order
       they come back in, and within a kind that is alphabetical. */
    final rows = await db.rawQuery(
      'SELECT kind, name FROM tags WHERE work_id = ?',
      [workId],
    );
    final out = <String, List<String>>{};
    for (final row in rows) {
      (out['${row['kind']}'] ??= []).add('${row['name']}');
    }
    return out;
  }

  /// Keep it for later, or stop keeping it.
  Future<void> markLater(String workId, {required bool later}) => db.rawInsert(
    'INSERT INTO reading (work_id, marked_later) VALUES (?, ?) '
    'ON CONFLICT(work_id) DO UPDATE SET marked_later = excluded.marked_later',
    [workId, later ? 1 : 0],
  );

  Future<List<ChapterRow>> chapters(String workId) async {
    final rows = await db.rawQuery(
      'SELECT number, title FROM chapters WHERE work_id = ? ORDER BY number',
      [workId],
    );
    return rows
        .map((r) => ChapterRow(r['number'] as int, r['title'] as String?))
        .toList();
  }

  /// The pictures this work has, by the address the markup points at.
  ///
  /// Read once for a whole work rather than per chapter: a reader turning to
  /// chapter nine should not wait on a second query for an image the app has
  /// already been holding since chapter one.
  Future<Map<String, ({String mime, Uint8List bytes})>> picturesFor(
    String workId,
  ) async {
    final rows = await db.rawQuery(
      'SELECT url, mime, bytes FROM images '
      "WHERE work_id = ? AND status = 'stored' AND bytes IS NOT NULL",
      [workId],
    );
    return {
      for (final row in rows)
        '${row['url']}': (
          mime: (row['mime'] as String?) ?? 'image/*',
          bytes: row['bytes']! as Uint8List,
        ),
    };
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
  /// One shelf, and how much of it is not on it.
  Future<(List<WorkRow>, int)> shelf(core.Shelf shelf, {int limit = 12}) async {
    final rows = await db.rawQuery(shelf.sql(limit: limit));
    final counted = await db.rawQuery(shelf.countSql);
    return (
      rows.map(WorkRow.fromMap).toList(),
      (counted.first['n'] as int?) ?? 0,
    );
  }

  /// What the library amounts to.
  Future<Stats> stats() async {
    final totals = (await db.rawQuery(core.statsSql)).first;
    final read = (await db.rawQuery(core.readStatsSql)).first;
    return Stats(
      works: totals['works'] as int? ?? 0,
      words: (totals['words'] as num?)?.toInt() ?? 0,
      later: totals['later'] as int? ?? 0,
      finished: read['finished'] as int? ?? 0,
      wordsRead: (read['wordsRead'] as num?)?.toInt() ?? 0,
    );
  }

  /// One facet's counts, against the filters already in force.
  Future<List<Count>> facet(core.FacetQuery q) async {
    final rows = await db.rawQuery(q.sql, q.args);
    return rows
        .map((r) => Count('${r['name']}', r['n'] as int? ?? 0))
        .where((c) => c.name.isNotEmpty && c.name != 'null')
        .toList();
  }

  /// The busiest handful of each kind, for the ways in that are not a list.
  ///
  /// Asked of the whole library rather than of whatever is filtered, because
  /// this is the front door: narrowing it by what somebody last looked at
  /// would make the door lead back where they already were.
  Future<Map<String, List<Count>>> browse() async {
    final out = <String, List<Count>>{};
    for (final (kind, _, howMany) in core.browseKinds) {
      try {
        final counts = kind == 'rating'
            ? await facet(core.columnFacet(const {}, 'rating'))
            : await facet(core.tagFacet(const {}, kind, limit: howMany));
        if (counts.isNotEmpty) out[kind] = counts;
      } catch (_) {
        /* A library old enough to be missing a table is a library with fewer
           ways in, not a Home screen that will not draw. */
      }
    }
    return out;
  }

  /// Something nobody has opened. Null when there is nothing left unread.
  Future<String?> surprise() async {
    final rows = await db.rawQuery(core.surpriseSql);
    return rows.isEmpty ? null : '${rows.first['work_id']}';
  }

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

  /// How this library is read. Kept in the library rather than in the app's
  /// own preferences, so a backup carries it and a new phone opens to the type
  /// the last one was reading in.
  Future<core.ReadingPrefs> readingPrefs() => core.loadPrefs(_Runner(db));

  Future<void> saveReadingPrefs(core.ReadingPrefs prefs) async {
    final batch = db.batch();
    prefs.toMap().forEach((key, value) {
      final row = {'key': key, 'value': value};
      batch.insert('meta', row, conflictAlgorithm: ConflictAlgorithm.replace);
    });
    await batch.commit(noResult: true);
  }

  /// Letting go of a work.
  ///
  /// A work is not one row, and the order matters: the chapter index is
  /// external-content FTS4 keyed on `chapters.rowid`, so it goes first and by
  /// hand. The list and the order live in folio_core, where a fixture written
  /// by 1.x holds all three implementations to the same answer.
  Future<void> deleteWork(String workId) async {
    final found = await db.rawQuery(
      'SELECT title FROM works WHERE work_id = ?',
      [workId],
    );
    final title = found.isEmpty ? null : found.first['title'];

    await db.transaction((txn) async {
      final chapters = await txn.rawQuery(
        'SELECT id FROM chapters WHERE work_id = ?',
        [workId],
      );
      for (final row in chapters) {
        await txn.rawDelete('DELETE FROM ${core.indexFirst} WHERE rowid = ?', [
          row['id'],
        ]);
      }
      for (final sql in core.deleteStatements()) {
        await txn.rawDelete(sql, [workId]);
      }
      // the tombstone is written in the same transaction as the removal: a
      // work gone from the library and absent from here is one the next
      // listing quietly restores, which is worse than not deleting it
      await txn.rawInsert(core.tombstone, [workId, title]);
    });
  }

  Future<List<String>> blockedNames() async {
    final rows = await db.rawQuery('SELECT name FROM blocked ORDER BY name');
    return rows.map((row) => '${row['name']}').toList();
  }

  /// Never fetch them again, and stop showing what is solely theirs.
  ///
  /// Only the works this one name could affect are restated, matched the way
  /// the author filter matches — the name quoted as it appears inside the JSON
  /// array, so blocking "Anna" does not touch "Annabel". A work is hidden only
  /// when every author of it is blocked: one name on a work with two is a work
  /// you keep.
  Future<void> setBlocked(String name, {required bool blocked}) =>
      db.transaction((txn) async {
        if (blocked) {
          await txn.rawInsert(
            'INSERT OR REPLACE INTO blocked (name, at) '
            "VALUES (?, datetime('now'))",
            [name],
          );
        } else {
          await txn.rawDelete('DELETE FROM blocked WHERE name = ?', [name]);
        }

        final names = (await txn.rawQuery('SELECT name FROM blocked'))
            .map((row) => '${row['name']}')
            .toSet();
        final affected = await txn.rawQuery(
          "SELECT work_id, authors FROM works WHERE authors LIKE ? ESCAPE '\\'",
          [core.worksByPattern(name)],
        );
        for (final row in affected) {
          await txn.rawUpdate('UPDATE works SET hidden = ? WHERE work_id = ?', [
            core.isHidden(row['authors'], names) ? 1 : 0,
            row['work_id'],
          ]);
        }
      });

  /// Copy the whole library out to a file somebody picked.
  ///
  /// The database runs in WAL mode, so it is really several files: copying
  /// archive.db alone silently drops whatever the write-ahead log still holds,
  /// which is the most recent reading of all. Checkpointing first folds the
  /// log back into the file being copied — a backup that is missing the last
  /// hour is worse than no backup, because it is trusted.
  Future<int> backupTo(String destination) async {
    try {
      await db.rawQuery('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (_) {
      // an un-checkpointable library still copies; it may just lag a little
    }
    final copy = await File(path).copy(destination);
    return copy.lengthSync();
  }

  /// What a backup of this library should be called.
  ///
  /// Dated, because the reason to keep one is to have the one from before
  /// whatever went wrong, and three files called archive.db in a downloads
  /// folder are one file as far as anybody can tell.
  static String backupName([DateTime? at]) {
    final day = (at ?? DateTime.now()).toIso8601String().substring(0, 10);
    return 'fan-folio-$day.db';
  }

  /// The counts that are about you rather than about the library.
  Future<({int bookmarked, int finished, int later})> yours() async {
    final rows = await db.rawQuery('''
      SELECT
        (SELECT count(*) FROM works
          WHERE COALESCE(in_bookmarks, 0) = 1 AND COALESCE(hidden, 0) = 0)
          AS bookmarked,
        (SELECT count(*) FROM reading WHERE COALESCE(marked_later, 0) = 1)
          AS later
    ''');
    final read = await db.rawQuery(core.readStatsSql);
    return (
      bookmarked: rows.first['bookmarked'] as int? ?? 0,
      later: rows.first['later'] as int? ?? 0,
      finished: read.first['finished'] as int? ?? 0,
    );
  }

  /// The works one person has bookmarked, as far as this library knows.
  ///
  /// Recorded by walking their bookmark pages: one request describes twenty,
  /// so this is a list somebody can browse rather than a button that fetches.
  Future<List<WorkRow>> bookmarkedBy(String person, {int limit = 500}) async {
    final rows = await db.rawQuery(
      '''
      SELECT w.*, r.marked_later,
             (SELECT name FROM tags t
               WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1)
               AS fandom
      FROM bookmarked_by b
      JOIN works w ON w.work_id = b.work_id
      LEFT JOIN reading r ON r.work_id = w.work_id
      WHERE b.person = ? AND COALESCE(w.hidden, 0) = 0
      ORDER BY b.at DESC, w.title COLLATE NOCASE
      LIMIT ?''',
      [person, limit],
    );
    return rows.map(WorkRow.fromMap).toList();
  }

  /// Whose bookmark list these works are in.
  ///
  /// Added to rather than replaced: a walk reads the pages it can reach, and
  /// treating a partial read as the whole truth would drop everything below
  /// where it stopped.
  Future<void> noteBookmarkedBy(String person, List<String> workIds) async {
    if (workIds.isEmpty) return;
    final at = DateTime.now().toIso8601String().substring(0, 19);
    await db.transaction((txn) async {
      for (final workId in workIds) {
        await txn.rawInsert(
          'INSERT OR IGNORE INTO bookmarked_by (person, work_id, at) '
          'VALUES (?,?,?)',
          [person, workId, at],
        );
      }
    });
  }

  /// When somebody's works or bookmarks were last walked.
  Future<DateTime?> lastWalk(String key) async {
    try {
      final rows = await db.rawQuery('SELECT value FROM meta WHERE key = ?', [
        'walk.$key',
      ]);
      return rows.isEmpty ? null : DateTime.tryParse('${rows.first['value']}');
    } catch (_) {
      return null;
    }
  }

  Future<void> noteWalk(String key) async {
    final row = {'key': 'walk.$key', 'value': DateTime.now().toIso8601String()};
    await db.insert('meta', row, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  /// Works the reader deleted, which are not to come back on their own.
  Future<Set<String>> refusedIds() async {
    final rows = await db.rawQuery('SELECT work_id FROM deleted');
    return {for (final row in rows) '${row['work_id']}'};
  }

  /// Which works are your bookmarks now — all of them, as one answer.
  ///
  /// Removal cannot be seen a page at a time, because it is the absence of
  /// something: a work that has stopped being bookmarked simply does not
  /// appear, and nothing on any page says so. So the whole list replaces the
  /// whole list, in one transaction, because a half-applied reconciliation is
  /// worse than none.
  ///
  /// Only membership changes. The works themselves are left alone — you
  /// unbookmarked it, you did not ask to lose it.
  Future<({int kept, int dropped})> reconcileBookmarks(
    List<String> workIds,
  ) async {
    var dropped = 0;
    await db.transaction((txn) async {
      await txn.execute(
        'CREATE TEMP TABLE IF NOT EXISTS bookmarks_now (work_id TEXT PRIMARY KEY)',
      );
      await txn.delete('bookmarks_now');
      for (final workId in workIds) {
        await txn.rawInsert(
          'INSERT OR IGNORE INTO bookmarks_now (work_id) VALUES (?)',
          [workId],
        );
      }
      final counted = await txn.rawQuery(
        'SELECT count(*) AS n FROM works WHERE in_bookmarks = 1 '
        'AND work_id NOT IN (SELECT work_id FROM bookmarks_now)',
      );
      dropped = counted.first['n'] as int? ?? 0;

      await txn.rawUpdate(
        'UPDATE works SET in_bookmarks = 0 WHERE in_bookmarks = 1 '
        'AND work_id NOT IN (SELECT work_id FROM bookmarks_now)',
      );
      await txn.rawUpdate(
        'UPDATE works SET in_bookmarks = 1 '
        'WHERE work_id IN (SELECT work_id FROM bookmarks_now)',
      );
    });
    return (kept: workIds.length, dropped: dropped);
  }

  /// When the bookmarks were last walked, so the reader can see it is current.
  Future<DateTime?> lastBookmarkSync() async {
    try {
      final rows = await db.rawQuery(
        "SELECT value FROM meta WHERE key = 'sync.bookmarks'",
      );
      return rows.isEmpty ? null : DateTime.tryParse('${rows.first['value']}');
    } catch (_) {
      return null;
    }
  }

  Future<void> noteBookmarkSync(DateTime at) async {
    final row = {'key': 'sync.bookmarks', 'value': at.toIso8601String()};
    await db.insert('meta', row, conflictAlgorithm: ConflictAlgorithm.replace);
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

/// What the library amounts to: the line that makes Home read as somebody's
/// own archive rather than a generic discovery screen.
class Stats {
  const Stats({
    required this.works,
    required this.words,
    required this.later,
    required this.finished,
    required this.wordsRead,
  });

  final int works;
  final int words;
  final int later;
  final int finished;
  final int wordsRead;
}

/// A value somebody could narrow by, and how much of the library it leaves.
class Count {
  const Count(this.name, this.n);
  final String name;
  final int n;
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
