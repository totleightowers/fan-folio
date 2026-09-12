/// What Home offers, and the questions behind it.
///
/// 1596 works sorted alphabetically is a filing cabinet, not a library. What
/// somebody wants on opening a reading app is the thing they were in the
/// middle of, then a few ways in. Ported from the shelves 1.x builds so the
/// two versions open on the same screen.
library;

import 'query.dart';

/// One shelf: what it is called, what is on it, and how it is ordered.
class Shelf {
  const Shelf({
    required this.key,
    required this.title,
    required this.where,
    required this.order,
    this.view = const {},
  });

  final String key;
  final String title;

  /// The predicate, already narrowed to what a blocked author has not taken
  /// out — Home builds its shelves by hand rather than through the query
  /// builder, and the two disagreeing is how a hidden work ends up offered on
  /// the front page.
  final String where;
  final String order;

  /// The filters See all should apply, so the button lands on the same
  /// question the shelf asked rather than on the whole library with a sort.
  final Map<String, Object?> view;

  String get shownWhere => shown(where);

  /// The rows of the shelf.
  String sql({int limit = 12}) => '''
SELECT w.work_id, w.title, w.authors, w.summary, w.words, w.chapter_count,
       w.complete, w.rating, w.has_text, w.skin_css,
       r.chapter AS at_chapter, r.chapters_read, r.marked_later,
       (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1) AS fandom
FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
WHERE $shownWhere ORDER BY $order LIMIT $limit''';

  /// How much of it is not on it.
  String get countSql => '''
SELECT count(*) AS n FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
WHERE $shownWhere''';
}

/// The shelves, in the order they are offered.
///
/// Continue reading first, because carrying on with a work is why anybody
/// opens a reading app, and a number never has been.
List<Shelf> shelves() => [
      Shelf(
        key: 'reading',
        title: 'Continue reading',
        where: states['reading']!,
        // most recently opened first, whichever shelf it was opened from
        order: 'COALESCE(r.opened_at, r.updated_at) DESC',
        view: const {'state': 'reading'},
      ),
      Shelf(
        key: 'later',
        title: 'Marked for later',
        where: 'r.marked_later = 1',
        order: 'w.title COLLATE NOCASE',
        view: const {'state': 'later'},
      ),
      Shelf(
        key: 'added',
        title: 'Recently added',
        where: '1=1',
        order: 'COALESCE(w.downloaded_at, w.fetched_at) DESC',
        view: const {'state': 'all', 'sort': 'added'},
      ),
      Shelf(
        key: 'long',
        title: 'Settle in',
        where: 'w.complete = 1 AND ${states['unread']}',
        order: 'w.words DESC',
        view: const {'state': 'unread', 'complete': '1', 'sort': 'words'},
      ),
      Shelf(
        key: 'short',
        title: 'One sitting',
        where: 'w.complete = 1 AND w.words < 5000 AND ${states['unread']}',
        order: 'RANDOM()',
        view: const {
          'state': 'unread',
          'complete': '1',
          'wordsMax': 5000,
          'sort': 'shortest',
        },
      ),
    ];

/// One work nobody has opened, chosen at random.
///
/// The point of it is that it is not a list. A library big enough to be worth
/// having is big enough that choosing from it is its own small task, and the
/// answer to "I want to read something" is often a work rather than a screen.
/// Never opened, because offering something half-read as a surprise is just
/// the Continue reading shelf with a worse name.
String get surpriseSql => '''
SELECT w.work_id FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
WHERE ${shown(states['unread']!)} ORDER BY RANDOM() LIMIT 1''';

/// The ways in that are not a list.
///
/// Fic is found by fandom and pairing far more often than by title, so those
/// are the front door. Each of these is a facet with a filter behind it:
/// choosing one lands in the library already narrowed, rather than on a
/// category page that is a second kind of list.
///
/// The counts are the busiest handful rather than all of them — a library
/// holds more pairings than anybody will scroll past, and the filter panel is
/// where the rest are searched for.
const List<(String kind, String title, int howMany)> browseKinds = [
  ('fandom', 'Fandoms', 14),
  ('relationship', 'Pairings', 14),
  ('character', 'Characters', 12),
  ('freeform', 'Tags', 14),
  ('rating', 'Rating', 0),
];

/// What the library amounts to, which is what makes Home read as somebody's
/// own archive rather than a generic discovery screen.
const String statsSql = '''
SELECT count(*) AS works,
       COALESCE(sum(w.words), 0) AS words,
       (SELECT count(*) FROM reading WHERE marked_later = 1) AS later
FROM works w WHERE COALESCE(w.hidden, 0) = 0''';

/// Finished, and the words in them, asked the way the library asks it.
String get readStatsSql => '''
SELECT count(CASE WHEN $finished THEN 1 END) AS finished,
       COALESCE(sum(CASE WHEN $finished THEN w.words ELSE 0 END), 0) AS wordsRead
FROM works w JOIN reading r ON r.work_id = w.work_id
WHERE COALESCE(w.hidden, 0) = 0''';
