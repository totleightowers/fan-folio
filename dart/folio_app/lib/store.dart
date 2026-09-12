import 'dart:convert';

import 'package:folio_core/folio_core.dart' as core;
import 'package:sqflite/sqflite.dart';

/// Where a fetched work goes.
///
/// The shape of a work was decided in folio_core, by the code that parsed it.
/// Nothing here makes a decision about what a work is; it writes what it is
/// given, in the order the tables require — which is the one thing this file
/// does own, because getting it wrong leaves a search index answering for
/// chapters that are not there.
class LibraryStore implements core.WorkStore {
  const LibraryStore(this.db);

  final Database db;

  @override
  Future<Set<String>> held(List<String> workIds) async {
    if (workIds.isEmpty) return const {};
    final marks = List.filled(workIds.length, '?').join(',');
    final rows = await db.rawQuery(
      'SELECT work_id FROM works '
      'WHERE work_id IN ($marks) AND COALESCE(has_text, 0) = 1',
      workIds,
    );
    return {for (final row in rows) '${row['work_id']}'};
  }

  @override
  Future<Set<String>> refused(List<String> workIds) async {
    if (workIds.isEmpty) return const {};
    final marks = List.filled(workIds.length, '?').join(',');
    final rows = await db.rawQuery(
      'SELECT work_id FROM deleted WHERE work_id IN ($marks)',
      workIds,
    );
    return {for (final row in rows) '${row['work_id']}'};
  }

  /// Let a work be fetched again after it was deleted.
  ///
  /// Asking for a work by name plainly outranks a refusal made last month, so
  /// adding one by link drops the tombstone first. Nothing automatic does.
  Future<void> allow(String workId) async {
    await db.delete('deleted', where: 'work_id = ?', whereArgs: [workId]);
  }

  @override
  Future<void> save(core.StoredWork work) async {
    final now = DateTime.now();
    final stamp = now.toIso8601String().substring(0, 19).replaceFirst('T', ' ');
    final today = stamp.substring(0, 10);

    await db.transaction((txn) async {
      /* Keep what is about to be replaced. An author who consolidates
         forty-four chapters into one is not deleting the work, but the
         chaptering is gone either way, and the copy on this device is the
         only record of what it used to be. */
      await _archiveChapters(txn, work);

      final row = {
        'work_id': work.workId,
        'title': work.title,
        'authors': jsonEncode(work.authors),
        'summary': work.summary,
        'rating': work.rating,
        'language': work.language,
        'complete': work.complete ? 1 : 0,
        'words': work.words ?? 0,
        'chapter_count': work.chapters.length,
        'skin_css': work.skinCss,
        'source': 'ao3',
        'fetched_at': stamp,
        // when this copy was taken. Without it the planner has no idea how
        // current the copy is, and Recently added cannot see the work at all.
        'downloaded_at': today,
        'has_text': 1,
      };
      await txn.insert(
        'works',
        row,
        conflictAlgorithm: ConflictAlgorithm.replace,
      );

      await txn.delete('tags', where: 'work_id = ?', whereArgs: [work.workId]);
      final every = <String>[];
      for (final entry in work.tags.entries) {
        for (final name in entry.value) {
          final tag = {'work_id': work.workId, 'kind': entry.key, 'name': name};
          await txn.insert(
            'tags',
            tag,
            conflictAlgorithm: ConflictAlgorithm.ignore,
          );
          every.add(name);
        }
      }

      /* Index entries are keyed on the chapter's rowid, so the old ones have
         to go before the rows they point at do — otherwise a search finds a
         chapter that no longer exists and cannot open it. */
      final old = await txn.rawQuery(
        'SELECT id FROM chapters WHERE work_id = ?',
        [work.workId],
      );
      for (final row in old) {
        await txn.delete(
          core.indexFirst,
          where: 'rowid = ?',
          whereArgs: [row['id']],
        );
      }
      await txn.delete(
        'chapters',
        where: 'work_id = ?',
        whereArgs: [work.workId],
      );

      for (final chapter in work.chapters) {
        final row = {
          'work_id': work.workId,
          'number': chapter.number,
          'title': chapter.title,
          'html': chapter.html,
          'text': chapter.text,
          'words': chapter.words,
        };
        final rowid = await txn.insert(
          'chapters',
          row,
          conflictAlgorithm: ConflictAlgorithm.replace,
        );

        // external-content FTS4 takes rowid, not docid, on a direct insert
        final indexed = {'rowid': rowid, 'text': chapter.text};
        await txn.insert(
          core.indexFirst,
          indexed,
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }

      await txn.delete(
        'work_fts',
        where: 'work_id = ?',
        whereArgs: [work.workId],
      );
      final meta = {
        'work_id': work.workId,
        'title': work.title ?? '',
        'authors': work.authors.join(', '),
        'summary': work.summary ?? '',
        'tags': every.join(', '),
      };
      await txn.insert(
        'work_fts',
        meta,
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
    });
  }

  /// Copy any chapter about to be replaced into chapter_versions.
  ///
  /// Only what actually differs: refetching an unchanged work should leave no
  /// trace, or every refetch would bury the real changes under copies of
  /// chapters nobody touched.
  Future<void> _archiveChapters(
    DatabaseExecutor txn,
    core.StoredWork work,
  ) async {
    final incoming = {
      for (final chapter in work.chapters)
        chapter.number: _settled(chapter.html),
    };

    List<Map<String, Object?>> current;
    try {
      current = await txn.rawQuery(
        'SELECT number, title, html, text, words '
        'FROM chapters WHERE work_id = ?',
        [work.workId],
      );
    } catch (_) {
      // a library without the table is not worth failing a download over
      return;
    }

    final at = DateTime.now()
        .toIso8601String()
        .substring(0, 19)
        .replaceFirst('T', ' ');
    for (final row in current) {
      final number = row['number'] as int?;
      final gone = !incoming.containsKey(number);
      if (!gone && _settled('${row['html'] ?? ''}') == incoming[number]) {
        continue; // unchanged
      }
      try {
        await txn.insert('chapter_versions', {
          'work_id': work.workId,
          'number': number,
          'title': row['title'],
          'html': row['html'],
          'text': row['text'],
          'words': row['words'],
          'reason': gone ? 'removed' : 'content',
          'archived_at': at,
        });
      } catch (_) {
        // likewise: an archive that cannot be written is not a lost work
      }
    }
  }
}

/// Works a listing described, without fetching any of them.
///
/// One request describes twenty works; fetching twenty costs twenty. This is
/// how somebody's whole catalogue becomes browsable for the price of reading
/// their index — and it is what makes a Works tab a list rather than a button.
///
/// Never over a work already held: a blurb knows less than a work page, and
/// CONFLICT_IGNORE is the difference between filling in the gaps and writing
/// a summary over a work somebody has read.
Future<int> saveStubs(
  Database db,
  List<core.Blurb> listed, {
  Set<String> refused = const {},
}) async {
  var added = 0;
  await db.transaction((txn) async {
    for (final blurb in listed) {
      /* A listing describes it; that is not a reason to put back something
         taken out on purpose. */
      if (refused.contains(blurb.workId)) continue;

      final row = {
        'work_id': blurb.workId,
        'title': blurb.title,
        'authors': jsonEncode(blurb.authors),
        'summary': blurb.summary,
        'rating': blurb.rating,
        'language': blurb.language,
        'complete': blurb.complete ? 1 : 0,
        'words': blurb.words,
        'chapter_count': blurb.chapters,
        /* How many the author says there will be. Without it a finished
           one-chapter work reads "1/?", which says the archive does not
           know — when the listing had just told us. */
        'chapters_planned': blurb.chaptersPlanned,
        'kudos': blurb.kudos,
        'bookmark_count': blurb.bookmarkCount,
        'hits': blurb.hits,
        'source': 'listing',
        'has_text': 0,
      };
      final at = await txn.insert(
        'works',
        row,
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );
      if (at == 0) continue; // already held, and left alone
      added++;

      for (final entry in {
        'fandom': blurb.fandoms,
        'relationship': blurb.relationships,
        'character': blurb.characters,
        'freeform': blurb.freeform,
        'warning': blurb.warnings,
        'category': blurb.categories,
      }.entries) {
        for (final name in entry.value) {
          await txn.insert('tags', {
            'work_id': blurb.workId,
            'kind': entry.key,
            'name': name,
          }, conflictAlgorithm: ConflictAlgorithm.ignore);
        }
      }
    }
  });
  return added;
}

/// Where the pictures in a work go.
///
/// The same database as the text, because a picture that lives somewhere else
/// is a picture a backup loses and a delete leaves behind.
class LibraryPictures implements core.PictureStore {
  const LibraryPictures(this.db);

  final Database db;

  @override
  Future<Set<String>> settled(String workId) async {
    final rows = await db.rawQuery('SELECT url FROM images WHERE work_id = ?', [
      workId,
    ]);
    return {for (final row in rows) '${row['url']}'};
  }

  @override
  Future<void> put(String workId, core.StoredPicture picture) async {
    final row = {
      'work_id': workId,
      'url': picture.url,
      'sha256': picture.sha256,
      'mime': picture.mime,
      'bytes': picture.bytes,
      // why it is not here, so it is not asked for again every open
      'status': picture.stored ? 'stored' : (picture.trouble ?? 'no'),
      'fetched_at': DateTime.now().toIso8601String().substring(0, 19),
    };
    await db.insert(
      'images',
      row,
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }
}

/// Whitespace is not a change. Compared the way 1.x compares it.
String _settled(String? html) =>
    (html ?? '').replaceAll(RegExp(r'\s+'), ' ').trim();
