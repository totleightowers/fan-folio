import 'dart:convert';
import 'dart:io';

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// What to fetch, and what the archive's own forms say to send.
///
/// Both are places where being subtly wrong is expensive and quiet. A wrong
/// "skip" leaves a gap in the library nobody notices until they open the work;
/// a form field read wrongly submits a private bookmark as a public one. So
/// `tools/emit-plan-conformance.mjs` records the 1.x answers and these require
/// the same ones.
void main() {
  final fixture =
      jsonDecode(File('test/conformance/plan.json').readAsStringSync())
          as Map<String, Object?>;

  Map<String, HeldWork> heldFromFixture() => {
        for (final entry in (fixture['held']! as Map<String, Object?>).entries)
          entry.key: HeldWork.fromMap(entry.value! as Map<String, Object?>),
      };

  Map<String, num?> listedFromFixture() => {
        for (final entry
            in (fixture['listed']! as Map<String, Object?>).entries)
          entry.key: entry.value as num?,
      };

  group('an epoch is a date, or it is nothing', () {
    for (final entry
        in (fixture['epochs'] as List).cast<Map<String, Object?>>()) {
      final epoch = entry['epoch'] as num?;
      test('$epoch', () => expect(epochToDate(epoch), entry['date']));
    }
  });

  test('the best date a held work can offer', () {
    final held = heldFromFixture();
    for (final entry
        in (fixture['heldAsOf'] as List).cast<Map<String, Object?>>()) {
      expect(heldAsOf(held[entry['key']]), entry['asOf'],
          reason: 'the two versions disagree about ${entry['key']}');
    }
  });

  test('and the plan those dates add up to', () {
    final plan = planSync(listedFromFixture(), heldFromFixture());
    final expected = fixture['plan']! as Map<String, Object?>;
    final actions = expected['actions']! as Map<String, Object?>;

    for (final action in PlanAction.values) {
      expect(plan[action], actions[action.name],
          reason: '${action.name} disagrees with 1.x');
    }
    expect(plan.reasons, expected['reasons'],
        reason: 'a plan nobody can read is a number to be trusted');

    final counts = expected['counts']! as Map<String, Object?>;
    expect(plan.listed, counts['listed']);
    expect(plan.requests, counts['requests']);
  });

  test('skins are wanted unless they are not', () {
    final plan =
        planSync(listedFromFixture(), heldFromFixture(), wantSkins: false);
    final counts = (fixture['planWithoutSkins']!
        as Map<String, Object?>)['counts']! as Map<String, Object?>;
    expect(plan[PlanAction.skin], isEmpty);
    expect(plan.requests, counts['requests']);
  });

  test('what a plan costs in wall clock', () {
    for (final entry
        in (fixture['estimates'] as List).cast<Map<String, Object?>>()) {
      final actual = estimate(entry['n']! as int);
      expect(actual.hours, entry['hours']);
      expect(actual.human, entry['human']);
    }
  });

  test('a work in both listings is fetched once and remembered as both', () {
    /* History and bookmarks overlap heavily — you bookmark what you read. */
    final merged = mergeListings(
      bookmarks: const {'a': 100, 'both': 100},
      history: const {'b': 200, 'both': 300},
    );
    final expected = fixture['merged']! as Map<String, Object?>;
    expect(merged.keys.toSet(), expected.keys.toSet());
    expected.forEach((workId, value) {
      final want = value! as Map<String, Object?>;
      expect(merged[workId]!.updatedAt, want['updatedAt'],
          reason: 'the two pages can disagree by a hit; keep the newer');
      expect(merged[workId]!.inBookmarks, want['inBookmarks']);
      expect(merged[workId]!.inHistory, want['inHistory']);
    });
  });

  group('what the archive asked for', () {
    for (final entry
        in (fixture['forms'] as List).cast<Map<String, Object?>>()) {
      test(entry['name'] as String, () {
        final want = entry['form'] as Map<String, Object?>?;
        final form = parseForm(
          entry['html'] as String?,
          entry['match']! as String,
        );
        if (want == null) {
          expect(form, isNull);
          return;
        }
        expect(form, isNotNull);
        expect(form!.action, want['action']);
        expect(form.method, want['method']);
        expect(form.fields, want['fields']);
        expect(encodeForm(form.fields), entry['body']);
      });
    }
  });

  test('the token, wherever it is on the page', () {
    for (final entry
        in (fixture['tokens'] as List).cast<Map<String, Object?>>()) {
      expect(csrfToken(entry['html'] as String?), entry['token'],
          reason: 'a token read wrongly is every write rejected');
    }
  });

  test('and a body the archive will accept', () {
    for (final entry
        in (fixture['encoded'] as List).cast<Map<String, Object?>>()) {
      final fields = (entry['fields']! as Map<String, Object?>).map(
        (key, value) => MapEntry(key, '$value'),
      );
      expect(encodeForm(fields), entry['body']);
    }
  });
}
