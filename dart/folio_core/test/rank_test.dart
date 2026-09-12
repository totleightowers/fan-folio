import 'dart:convert';
import 'dart:io';

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// The Dart ranker, held to the scores 1.x computes from the same blobs.
///
/// Ranking is the part of search nobody can eyeball: a wrong order looks like
/// a plausible order. So these are the blobs SQLite actually produced for real
/// queries over the real fixture, with the scores 1.x gave them.
void main() {
  final fixture = jsonDecode(
      File('test/conformance/search.json').readAsStringSync()) as Map<String, Object?>;

  group('a result scores what 1.x scores it', () {
    for (final entry in (fixture['cases'] as List).cast<Map<String, Object?>>()) {
      final query = entry['query'] as String;
      test('"$query"', () {
        final rows = (entry['rows'] as List).cast<Map<String, Object?>>();
        expect(rows, isNotEmpty, reason: 'the fixture should match something');
        for (final row in rows) {
          final blob = base64Decode(row['matchinfo'] as String);
          expect(
            bm25(blob),
            closeTo((row['score'] as num).toDouble(), 1e-9),
            reason: 'two rankers disagreeing by a hair still put different '
                'works first, for row ${row['rowid']}',
          );
        }
      });
    }
  });

  test('the order is best first', () {
    final entry = (fixture['cases'] as List)
        .cast<Map<String, Object?>>()
        .firstWhere((c) => (c['rows'] as List).length > 1);
    final rows = (entry['rows'] as List).cast<Map<String, Object?>>();
    final ranked = rank([
      for (final row in rows)
        {'rowid': row['rowid'], 'matchinfo': base64Decode(row['matchinfo'] as String)},
    ]);
    final scores = ranked.map((r) => r['score'] as double).toList();
    expect(scores, orderedEquals(([...scores]..sort((a, b) => b.compareTo(a)))));
    expect(ranked.first.containsKey('matchinfo'), isFalse,
        reason: 'the blob is working state, not something a caller should see');
  });

  test('a ranking failure degrades the order rather than losing the results', () {
    // Anything unparseable scores zero; nothing throws, because a search that
    // returns nothing is worse than one in an unhelpful order.
    expect(bm25(null), 0);
    expect(bm25(<int>[]), 0);
    expect(bm25([1, 2, 3]), 0);
    expect(rank([{'rowid': 1, 'matchinfo': null}]).length, 1);
  });
}
