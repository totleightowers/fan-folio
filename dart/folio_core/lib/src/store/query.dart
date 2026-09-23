/// Building the library query from a set of filters.
///
/// Ported from `app/core/query.js`, statement for statement and comment for
/// comment where the comment records why something is the way it is. Every
/// oddity in here was a bug once: the double NULLIF, the quoted author match,
/// the hidden column instead of a predicate over JSON. A rewrite that tidied
/// them away would find all of them again.
///
/// Nothing a reader types is concatenated into SQL. Column and sort names come
/// from the maps below and are looked up, never interpolated; every value is
/// bound. The only interpolated things are integers already validated here.
library;

/// The sorts a reader can choose, and the only orderings this will emit.
const Map<String, String> sorts = {
  'title': 'w.title COLLATE NOCASE ASC',
  'author': 'w.authors COLLATE NOCASE ASC',
  'updated': 'COALESCE(w.updated, w.published) DESC',
  'published': 'w.published DESC',

  /// When we got it. A fetched work sets fetched_at, and only the EPUB import
  /// ever set downloaded_at — so ordering by that alone put everything newly
  /// added at the very bottom of "recently added".
  'added': 'COALESCE(w.downloaded_at, w.fetched_at) DESC',
  'words': 'w.words DESC',
  'shortest': 'w.words ASC',
  'chapters': 'w.chapter_count DESC',
  'recent': 'r.updated_at DESC',

  /// NULLS LAST, spelled out: a work whose counts we have never seen should
  /// not outrank one with none, and in SQLite a NULL sorts first descending.
  'kudos': 'w.kudos IS NULL, w.kudos DESC',
  'bookmarks': 'w.bookmark_count IS NULL, w.bookmark_count DESC',
  'hits': 'w.hits IS NULL, w.hits DESC',
  'random': 'RANDOM()',
};

/// How many chapters a work really has.
///
/// `works.chapter_count` is metadata, and metadata goes missing: a listing
/// that parsed badly leaves it NULL, and in SQL `read < NULL` is unknown
/// rather than true — so a work you are visibly halfway through drops out of
/// every reading question on the strength of a column that has nothing to do
/// with reading.
///
/// Both fallbacks are NULLIF'd, and the second one is the point: `count(*)`
/// over no rows is 0, not NULL, so COALESCE stopped there and every work whose
/// text has not been downloaded — most of a library — had a chapter total of
/// zero. "Read at least none of them" is true of everything, so the entire
/// backlog was reported as finished.
const String chapters = 'COALESCE(NULLIF(w.chapter_count, 0), '
    'NULLIF((SELECT count(*) FROM chapters c WHERE c.work_id = w.work_id), 0), 1)';

/// Evidence a work has been read in at all.
///
/// Four kinds, because reading leaves four different marks. `opened_at` is the
/// app opening a chapter; `offset` is being partway down one, which is the
/// only trace a library carried over from an older app leaves; `chapters_read`
/// and `chapter` are progress recorded either way. Home used the first, third
/// and fourth, the Library filter only the third and fourth, and neither used
/// offset — so a work could sit on Continue reading and vanish when See all
/// asked the same question in the other file's words.
const String started = '(r.opened_at IS NOT NULL OR COALESCE(r.offset, 0) > 0 '
    'OR COALESCE(r.chapters_read, 0) > 0 OR COALESCE(r.chapter, 0) > 1)';

/// Every chapter accounted for.
const String finished = 'COALESCE(r.chapters_read, 0) >= $chapters';

/// The same question, asked only of what a blocked author has not taken out.
String shown(String where) => 'COALESCE(w.hidden, 0) = 0 AND ($where)';

/// Reading state, which lives in the reading table rather than on the work.
///
/// One definition each, used everywhere. The three partition the library:
/// started and unfinished, not started, finished.
const Map<String, String> states = {
  'all': '1=1',
  'reading': '$started AND NOT ($finished)',
  'unread': 'NOT $started',
  'finished': finished,
  'later': 'r.marked_later = 1',
  'rec': 'w.rec = 1',

  /// Whether the text is actually here. A listing describes thousands of works
  /// never downloaded; being able to ask for only what can be read now, or
  /// only what is still to fetch, is the point of keeping them apart.
  'held': 'w.has_text = 1',
  'known': 'w.has_text = 0',
  'bookmarked': 'w.in_bookmarks = 1',
  'history': 'w.in_history = 1',
};

const List<String> tagKinds = [
  'fandom',
  'relationship',
  'character',
  'freeform',
  'warning',
  'category',
];

/// An integer we are willing to write into SQL, having checked it is one.
int _int(Object? value, int fallback, [int? max]) {
  final n = value is num ? value.floor() : int.tryParse('${value ?? ''}');
  if (n == null || n < 0) return fallback;
  return max == null ? n : (n < max ? n : max);
}

List<String> _list(Object? value) {
  if (value == null) return const [];
  final items = value is List ? value : '$value'.split('\t');
  return items.map((v) => '$v'.trim()).where((v) => v.isNotEmpty).toList();
}

/// Escape what LIKE would otherwise treat as a wildcard.
String _likeLiteral(String text) =>
    text.replaceAllMapped(RegExp(r'[\\%_]'), (m) => '\\${m[0]}');

/// The JSON form of one string, which is how an author's name appears inside
/// the authors array. Written out rather than pulled from dart:convert so the
/// escaping is visible: it is the thing standing between "Anna" and "Annabel".
String _jsonString(String value) {
  final out = StringBuffer('"');
  for (final rune in value.runes) {
    final ch = String.fromCharCode(rune);
    switch (ch) {
      case '"':
        out.write(r'\"');
      case r'\':
        out.write(r'\\');
      case '\n':
        out.write(r'\n');
      case '\r':
        out.write(r'\r');
      case '\t':
        out.write(r'\t');
      default:
        if (rune < 0x20) {
          out.write('\\u${rune.toRadixString(16).padLeft(4, '0')}');
        } else {
          out.write(ch);
        }
    }
  }
  out.write('"');
  return out.toString();
}

/// A built query: the rows, the count of them, and the values to bind.
class WorksQuery {
  const WorksQuery(
      {required this.sql, required this.countSql, required this.args});

  final String sql;
  final String countSql;
  final List<Object?> args;
}

/// Filters:
///   state      one of [states]
///   include    tags a work must have (AND — every one of them)
///   exclude    tags a work must not have
///   rating     any of these ratings (OR)
///   author     any of these authors (OR)
///   bookmarkedBy  works in one person's bookmark list
///   language   exact match
///   complete   '1' | '0'
///   wordsMin / wordsMax, chaptersMin / chaptersMax
///   updatedAfter / updatedBefore   YYYY-MM-DD, inclusive
///   crossover  '1' more than one fandom, '0' exactly one
///   otp        exactly one saved relationship tag, independent of include[]
///   sort       one of [sorts]
WorksQuery buildWorksQuery([Map<String, Object?> filters = const {}]) {
  final where = <String>['1=1'];
  final args = <Object?>[];

  /// Blocked authors, everywhere at once.
  ///
  /// One column rather than a predicate over the authors JSON, because that
  /// would need JSON1 and Android's SQLite may not have it. Written here so
  /// every question the library asks inherits it, rather than each remembering
  /// separately and one of them forgetting.
  where.add('COALESCE(w.hidden, 0) = 0');
  where.add(states[filters['state']] ?? states['all']!);

  /// Included tags are an AND: "alpha/beta/omega" *and* "slow burn" is a much
  /// more useful question than either alone, and the one AO3's filters answer.
  for (final tag in _list(filters['include'])) {
    where.add(
        'EXISTS (SELECT 1 FROM tags t WHERE t.work_id = w.work_id AND t.name = ?)');
    args.add(tag);
  }
  for (final tag in _list(filters['exclude'])) {
    where.add(
        'NOT EXISTS (SELECT 1 FROM tags t WHERE t.work_id = w.work_id AND t.name = ?)');
    args.add(tag);
  }

  /// A restriction to a known set of works, used when a search supplies the
  /// candidates: the filters still apply on top, so searching inside the
  /// library never escapes the narrowing already done.
  final ids = _list(filters['ids']);
  if (ids.isNotEmpty) {
    where.add('w.work_id IN (${List.filled(ids.length, '?').join(',')})');
    args.addAll(ids);
  }

  /// Authors are stored as a JSON array on the work, so a name is matched as
  /// the quoted string it appears as inside it. A bare LIKE on the name alone
  /// would match "Anna" inside "Annabel"; the quotes are what stop it.
  final authors = _list(filters['author']);
  if (authors.isNotEmpty) {
    where.add(
        '(${List.filled(authors.length, "w.authors LIKE ? ESCAPE '\\'").join(' OR ')})');
    args.addAll(authors.map((name) => '%${_likeLiteral(_jsonString(name))}%'));
  }

  /// Works in one person's bookmark list — not the same question as "by this
  /// author", and one the library could not ask at all until recently.
  final bookmarkedBy = filters['bookmarkedBy'];
  if (bookmarkedBy != null && '$bookmarkedBy'.isNotEmpty) {
    where.add('EXISTS (SELECT 1 FROM bookmarked_by b '
        'WHERE b.work_id = w.work_id AND b.person = ?)');
    args.add('$bookmarkedBy');
  }

  final ratings = _list(filters['rating']);
  if (ratings.isNotEmpty) {
    where.add('w.rating IN (${List.filled(ratings.length, '?').join(',')})');
    args.addAll(ratings);
  }

  final language = filters['language'];
  if (language != null && '$language'.isNotEmpty) {
    where.add('w.language = ?');
    args.add('$language');
  }

  final complete = filters['complete'];
  if (complete == '1' || complete == 1 || complete == true) {
    where.add('w.complete = 1');
  } else if (complete == '0' || complete == 0 || complete == false) {
    where.add('w.complete = 0');
  }

  // ranges are bound, not interpolated, so a nonsensical one is simply no match
  for (final (key, clause) in [
    ('wordsMin', 'w.words >= ?'),
    ('wordsMax', 'w.words <= ?'),
    ('chaptersMin', 'w.chapter_count >= ?'),
    ('chaptersMax', 'w.chapter_count <= ?'),
  ]) {
    final value = filters[key];
    if (value != null && '$value'.isNotEmpty) {
      where.add(clause);
      args.add(_int(value, 0));
    }
  }

  /// When it last changed. The date is stored as the archive writes it —
  /// YYYY-MM-DD — so it sorts and compares as text without parsing anything,
  /// and a work with no updated date falls back to when it was posted, the
  /// same way the column that displays it does.
  for (final (key, clause) in [
    ('updatedAfter', 'COALESCE(w.updated, w.published) >= ?'),
    ('updatedBefore', 'COALESCE(w.updated, w.published) <= ?'),
  ]) {
    final value = filters[key];
    if (value != null && '$value'.isNotEmpty) {
      where.add(clause);
      final text = '$value';
      args.add(text.length > 10 ? text.substring(0, 10) : text);
    }
  }

  // AO3 otp:true works without selecting a pairing. Saved tags do not carry
  // canonical/synonym identities, so count distinct relationship names.
  final otp = filters['otp'];
  if (otp == '1' || otp == 1 || otp == true) {
    where.add("(SELECT count(DISTINCT t.name) FROM tags t "
        "WHERE t.work_id = w.work_id AND t.kind = 'relationship') = 1");
  }

  /// Crossovers: a work in more than one fandom. The archive treats this as a
  /// yes-or-no of its own rather than something you assemble out of fandom
  /// tags, because assembling it is the thing you cannot do.
  final crossover = filters['crossover'];
  if (crossover == '1') {
    where.add("(SELECT count(DISTINCT t.name) FROM tags t "
        "WHERE t.work_id = w.work_id AND t.kind = 'fandom') > 1");
  } else if (crossover == '0') {
    where.add("(SELECT count(DISTINCT t.name) FROM tags t "
        "WHERE t.work_id = w.work_id AND t.kind = 'fandom') <= 1");
  }

  final order = sorts[filters['sort']] ?? sorts['title']!;
  final limit = _int(filters['limit'], 50, 200);
  final offset = _int(filters['offset'], 0, 1000000);

  final from = 'FROM works w LEFT JOIN reading r ON r.work_id = w.work_id '
      'WHERE ${where.join(' AND ')}';

  return WorksQuery(
    args: args,
    countSql: 'SELECT count(*) AS n $from',
    sql: '''
SELECT w.work_id, w.title, w.authors, w.summary, w.words, w.chapter_count,
       w.chapters_planned, w.complete, w.rating, w.published, w.updated,
       w.downloaded_at, w.language,
       w.skin_css IS NOT NULL AND w.skin_css <> '' AS has_skin,
       w.rec, w.in_bookmarks, w.in_history, w.bookmarked_at,
       w.kudos, w.bookmark_count, w.hits, w.has_text,
       r.chapter AS at_chapter, r.chapters_read, r.marked_later,
       (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1) AS fandom,
       (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'relationship' LIMIT 1) AS relationship
$from ORDER BY $order LIMIT $limit OFFSET $offset''',
  );
}
