/// What is left to narrow by, counted against what is already narrowed.
///
/// Counting against the filtered set rather than the whole library is what
/// makes a filter panel usable: it shows what narrowing further would actually
/// leave, so nobody picks a combination that yields nothing. Ported from 1.x,
/// where that was the point of building them this way.
library;

import 'query.dart';

/// A facet query: the counts, and the values to bind.
class FacetQuery {
  const FacetQuery({required this.sql, required this.args});
  final String sql;
  final List<Object?> args;
}

/// The rows of the current filter, as a subquery the facets can count within.
String _within(Map<String, Object?> filters) {
  final base = buildWorksQuery({...filters, 'limit': 1, 'offset': 0});
  return base.countSql
      .replaceFirst('SELECT count(*) AS n ', 'SELECT w.work_id ');
}

String _likeLiteral(String text) =>
    text.replaceAllMapped(RegExp(r'[\\%_]'), (m) => '\\${m[0]}');

/// Tags of one kind, with counts.
FacetQuery tagFacet(
  Map<String, Object?> filters,
  String kind, {
  int limit = 30,
  String needle = '',
}) {
  if (!tagKinds.contains(kind)) throw ArgumentError('unknown tag kind: $kind');
  final base = buildWorksQuery({...filters, 'limit': 1, 'offset': 0});
  final args = [...base.args];
  var match = '';
  if (needle.isNotEmpty) {
    match = " AND t.name LIKE ? ESCAPE '\\'";
    args.add('%${_likeLiteral(needle)}%');
  }
  return FacetQuery(
    args: args,
    sql: '''
SELECT t.name, count(*) AS n FROM tags t
WHERE t.kind = '$kind' AND t.work_id IN (${_within(filters)})$match
GROUP BY t.name ORDER BY n DESC, t.name LIMIT ${limit.clamp(1, 500)}''',
  );
}

/// Something a work holds in a column rather than in the tags table.
///
/// A rating is not a tag here: the archive presents it as one, but it is one
/// value per work and it is stored as a column. The facets were built by
/// looping over the tag kinds, so ratings were never counted — and the panel
/// draws its Rating section only when it has counts, which is to say never.
/// The filter behind it worked the whole time; there was no way to reach it.
///
/// The column being filtered on is dropped from its own counts, so choosing
/// Explicit does not make Mature vanish from the list you chose it from.
const Map<String, String> columnFacets = {
  'rating': 'w.rating',
  'language': 'w.language',
};

FacetQuery columnFacet(Map<String, Object?> filters, String column) {
  final col = columnFacets[column];
  if (col == null) throw ArgumentError('unknown column facet: $column');
  final without = {...filters, 'limit': 1, 'offset': 0}..remove(column);
  final base = buildWorksQuery(without);
  return FacetQuery(
    args: base.args,
    sql: '''
SELECT $col AS name, count(*) AS n FROM works w
WHERE $col IS NOT NULL AND $col <> '' AND w.work_id IN (${_within(without)})
GROUP BY $col ORDER BY n DESC, $col''',
  );
}

/// Who wrote them, counted.
///
/// Authors are a JSON array on the work rather than rows in the tags table, so
/// counting them needs json_each. That is present in every SQLite this app is
/// likely to meet and absent from the oldest it will run on, so the caller is
/// expected to try it and do without the section if it fails — an Authors
/// filter is worth having and not worth a blank screen.
///
/// Searching reaches past the top of the list on purpose: a library holds far
/// more names than anyone will scroll, and a search that sifts only the
/// handful already shown cannot find the rest at all.
FacetQuery authorFacet(
  Map<String, Object?> filters, {
  int limit = 40,
  String needle = '',
}) {
  final without = {...filters, 'author': const <String>[]};
  final base = buildWorksQuery({...without, 'limit': 1, 'offset': 0});
  final args = [...base.args];
  var match = '';
  if (needle.isNotEmpty) {
    match = " AND j.value LIKE ? ESCAPE '\\'";
    args.add('%${_likeLiteral(needle)}%');
  }
  return FacetQuery(
    args: args,
    sql: '''
SELECT j.value AS name, count(*) AS n
  FROM works w, json_each(w.authors) j
 WHERE w.work_id IN (${_within(without)})$match
 GROUP BY j.value ORDER BY n DESC, j.value LIMIT ${limit.clamp(1, 500)}''',
  );
}
