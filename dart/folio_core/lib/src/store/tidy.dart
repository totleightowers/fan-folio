/// Letting go of a work, and of an author.
///
/// Both halves of this are a list and an order, and both were already written
/// once — in `app/core/store/delete.js` and `app/core/store/blocked.js`, where
/// the shell in Java and the dev server in JavaScript are held to them. This
/// is the third port, and it is held to the same answers by a fixture the 1.x
/// implementation writes. The three of them drifting is not a thing anybody
/// notices until a phone is doing it.
library;

import 'dart:convert';

/// The chapter index goes first, and by hand.
///
/// chapter_fts is external-content FTS4 keyed on `chapters.rowid`. Deleting the
/// chapters first leaves index rows pointing at chapters that no longer exist,
/// and a search then finds a work that has been deleted and cannot open it.
const String indexFirst = 'chapter_fts';

/// Then these, each by work_id, in one transaction.
///
/// A work is not one row. It is a row, its tags, its chapters, two search
/// indexes, the pictures fetched for it, the copies kept of chapters an author
/// revised, the skin it was published with, and where the reader had got to in
/// it. Leaving any of those behind is a library that grows a little every time
/// somebody tidies it.
const List<String> workOwns = [
  'chapters',
  'work_fts',
  'tags',
  'images',
  'chapter_versions',
  'skin_versions',
  'reading_visits',
  'reading',
  'works',
];

/// The statements, for a backend that can run them straight.
List<String> deleteStatements() => [
  for (final table in workOwns) 'DELETE FROM $table WHERE work_id = ?',
];

/// And the tombstone, which is the half that makes it stay deleted.
///
/// Written in the same transaction as the removal: a work that is gone from
/// the library and absent from here is a work the next listing quietly
/// restores, which is worse than not having deleted it at all — the reader
/// believes it is gone.
const String tombstone =
    'INSERT OR REPLACE INTO deleted (work_id, title, at) '
    "VALUES (?, ?, datetime('now'))";

/// Whatever the works table has in its authors column, as a list of names.
List<String> authorsOf(Object? raw) {
  if (raw is List) return raw.map((name) => '$name').toList();
  try {
    final parsed = jsonDecode('${raw ?? '[]'}');
    return parsed is List ? parsed.map((name) => '$name').toList() : const [];
  } catch (_) {
    /* Not JSON — an old import, or a column written by hand. A work whose
       authors cannot be read is a work nobody has blocked. */
    return const [];
  }
}

/// Is this work solely the work of blocked people?
///
/// Blocking is two promises: nothing of theirs is fetched again, and what is
/// already here stops being shown. The second needs a rule about
/// collaborations, because a work has more than one author more often than
/// people expect — so a work is hidden when *every* author of it is blocked.
/// One name on a work with two is a work you keep.
///
/// A work with no readable authors is never hidden. Hiding on the strength of
/// a field that failed to parse is how a library loses things silently, which
/// is the failure this app can least afford.
bool isHidden(Object? authors, Iterable<String> blocked) {
  final names = authorsOf(authors);
  if (names.isEmpty) return false;
  final set = blocked is Set<String> ? blocked : blocked.toSet();
  if (set.isEmpty) return false;
  return names.every(set.contains);
}

/// The works a name could possibly affect.
///
/// Matched the way the author filter matches: the name as it appears quoted
/// inside the JSON array, so blocking "Anna" does not touch "Annabel".
/// Blocking recomputes only these, not the library.
String worksByPattern(String name) {
  final quoted = jsonEncode(name)
      .replaceAllMapped(RegExp(r'[\\%_]'), (m) => '\\${m[0]}');
  return '%$quoted%';
}
