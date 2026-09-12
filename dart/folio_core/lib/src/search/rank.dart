/// Relevance ranking for FTS4.
///
/// FTS5 has bm25() built in; FTS4 does not, and Android's SQLite has shipped
/// FTS4 for years while FTS5 arrived only recently — so the index is FTS4 and
/// the ranking is computed here. Ported from app/core/search.js so the two
/// versions of this app rank identically: a search that returns different
/// orders in two places is a search nobody can reason about.
///
/// matchinfo('pcnalx') lays out 32-bit integers as:
///   p  number of phrases in the query
///   c  number of columns in the table
///   n  number of rows in the table
///   a  average length, one per column
///   l  length of this row, one per column
///   x  three values per (phrase, column): hits here, hits everywhere, rows hit
library;

import 'dart:math' as math;
import 'dart:typed_data';

/// Term-frequency saturation, SQLite's own documented default.
const double k1 = 1.2;

/// Length normalisation.
const double b = 0.75;

/// Little-endian 32-bit words out of the matchinfo blob.
List<int> readMatchinfo(Object? blob) {
  final bytes = switch (blob) {
    Uint8List b => b,
    List<int> l => Uint8List.fromList(l),
    _ => Uint8List(0),
  };
  final words = <int>[];
  for (var i = 0; i + 3 < bytes.length; i += 4) {
    words.add(bytes[i] |
        (bytes[i + 1] << 8) |
        (bytes[i + 2] << 16) |
        (bytes[i + 3] << 24));
  }
  return words;
}

/// A BM25 score for one row. Higher is better.
///
/// Returns 0 for anything unparseable rather than throwing: a ranking failure
/// should degrade the order of results, never lose them.
double bm25(Object? blob) {
  final m = readMatchinfo(blob);
  if (m.length < 3) return 0;

  final phrases = m[0];
  final columns = m[1];
  final totalRows = m[2];
  if (phrases == 0 || columns == 0 || totalRows == 0) return 0;

  const avgAt = 3;
  final lenAt = avgAt + columns;
  final xAt = lenAt + columns;
  if (m.length < xAt + phrases * columns * 3) return 0;

  var score = 0.0;
  for (var phrase = 0; phrase < phrases; phrase++) {
    for (var col = 0; col < columns; col++) {
      final base = xAt + 3 * (col + phrase * columns);
      final hitsHere = m[base];
      final rowsWithPhrase = m[base + 2];
      if (hitsHere == 0) continue;

      final avgLength = m[avgAt + col] == 0 ? 1 : m[avgAt + col];
      final length = m[lenAt + col] == 0 ? 1 : m[lenAt + col];

      // the usual BM25 idf, floored at zero so a term present in every row
      // cannot drag a score negative
      final idf = math.max(
        0.0,
        math.log((totalRows - rowsWithPhrase + 0.5) / (rowsWithPhrase + 0.5)),
      );
      final norm = k1 * (1 - b + (b * length) / avgLength);
      score += idf * ((hitsHere * (k1 + 1)) / (hitsHere + norm));
    }
  }
  return score;
}

/// How many rows to score before trimming.
///
/// Ranking happens after SQLite has returned rows in rowid order, so the
/// candidate pool has to be wider than the answer — or the best match for a
/// common word may never be considered at all.
const int candidates = 600;

/// Rank rows carrying a matchinfo blob, best first, trimmed to [limit].
List<Map<String, Object?>> rank(
  List<Map<String, Object?>> rows, {
  int limit = 40,
  String field = 'matchinfo',
}) {
  final scored = rows.map((row) => (row: row, score: bm25(row[field]))).toList()
    ..sort((x, y) => y.score.compareTo(x.score));
  return scored.take(limit).map((s) {
    // the blob is working state, not output
    final out = Map<String, Object?>.from(s.row)..remove(field);
    return out..['score'] = s.score;
  }).toList();
}
