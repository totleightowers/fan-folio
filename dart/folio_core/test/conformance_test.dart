import 'dart:convert';
import 'dart:io';

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// The Dart port, held to what the JavaScript actually answers.
///
/// Two ports passing two suites written by the same hand proves the hand was
/// consistent, not that the ports agree. `tools/emit-conformance.mjs` runs a
/// body of inputs through the 1.x implementation — the one that has been in
/// front of a real archive for weeks — and writes down what it said. This
/// reads the same file and requires the same answers.
///
/// When a rule legitimately changes, the fixture is regenerated and the diff
/// says exactly which answers moved. That is the review that matters here.
void main() {
  final file = File('test/conformance/urls.json');
  final fixture = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;

  group('links resolve the way 1.x resolves them', () {
    for (final entry in (fixture['links'] as List).cast<Map<String, Object?>>()) {
      final input = entry['input'] as String;
      test('"$input"', () {
        final expected = entry['target'] as Map<String, Object?>;
        final actual = linkTarget(input);

        expect(actual.kind.name, expected['kind'],
            reason: 'the two versions disagree about what this link is');
        expect(actual.workId, expected['workId']);
        expect(actual.chapterId, expected['chapterId']);
        expect(actual.seriesId, expected['seriesId']);
        expect(actual.externalId, expected['externalId']);

        expect(workIdFrom(input), entry['workId']);
        expect(isAo3Link(input), entry['isAo3']);
      });
    }
  });

  group('bylines point where 1.x points them', () {
    for (final entry in (fixture['bylines'] as List).cast<Map<String, Object?>>()) {
      final byline = entry['byline'] as String;
      test('"$byline"', () {
        expect(authorPath(byline), entry['path'],
            reason: 'a pseud read as a username is a 404 for a quarter of a library');
        expect(authorWorks(byline), entry['works']);
        expect(authorProfile(byline), entry['profile']);
        expect(isOrphan(byline), entry['orphan'],
            reason: 'an orphaned work read as an account is a million works to download');
      });
    }
  });
}
