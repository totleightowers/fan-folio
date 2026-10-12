import 'dart:convert';

import 'package:folio_core/folio_core.dart' as core;
import 'package:sqflite/sqflite.dart';

import 'library.dart';

WorkRow workFromBlurb(core.Blurb b) => WorkRow(
  workId: b.workId,
  title: b.title ?? '(untitled)',
  authors: b.authors,
  summary: b.summary,
  words: b.words,
  chapterCount: b.chapters,
  fandom: b.fandoms.firstOrNull,
  rating: b.rating,
  relationship: b.relationships.join(', '),
  language: b.language,
  complete: b.complete,
  updated: b.datetime,
  kudos: b.kudos,
  hits: b.hits,
  bookmarkCount: b.bookmarkCount,
);

class SavedSearch {
  const SavedSearch({
    required this.id,
    required this.name,
    required this.search,
    this.seen = const [],
    this.checked,
  });
  final String id;
  final String name;
  final core.ArchiveSearch search;
  final List<String> seen;
  final String? checked;

  Map<String, Object?> toJson() => {
    'name': name,
    'search': search.toJson(),
    'seen': seen,
    'checked': checked,
  };
}

/// Separate keys avoid overwriting another saved search during an update.
/// The existing backup includes this metadata without schema replacement.
class DiscoveryStore {
  const DiscoveryStore(this.library);
  final Library library;
  static const prefix = 'v5.search.';

  Future<List<SavedSearch>> all() async {
    final rows = await library.db.rawQuery(
      'SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key DESC',
      ['$prefix%'],
    );
    final found = <SavedSearch>[];
    for (final row in rows) {
      try {
        final data = jsonDecode(row['value'] as String) as Map<String, dynamic>;
        found.add(
          SavedSearch(
            id: (row['key'] as String).substring(prefix.length),
            name: data['name'] as String,
            search: core.ArchiveSearch.fromJson(
              Map<String, dynamic>.from(data['search'] as Map),
            ),
            seen: (data['seen'] as List? ?? []).cast<String>(),
            checked: data['checked'] as String?,
          ),
        );
      } on FormatException {
        continue;
      } on TypeError {
        continue;
      }
    }
    return found;
  }

  Future<void> save(SavedSearch search) async {
    final row = {
      'key': '$prefix${search.id}',
      'value': jsonEncode(search.toJson()),
    };
    await library.db.insert(
      'meta',
      row,
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<void> remove(String id) => library.db
      .delete('meta', where: 'key = ?', whereArgs: ['$prefix$id'])
      .then((_) {});
}
