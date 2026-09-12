import 'dart:math' as math;

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// A clock that only moves when something sleeps, so a test is not an hour.
class Clock {
  DateTime at = DateTime.utc(2026, 1, 1);
  final List<Duration> slept = [];

  Future<void> sleep(Duration d) async {
    slept.add(d);
    at = at.add(d);
  }

  DateTime now() => at;
}

void main() {
  test('requests are spaced, and the archive sees the total not the intent',
      () async {
    final clock = Clock();
    final pacer = Pacer(
      gap: const Duration(seconds: 10),
      random: math.Random(1),
      sleep: clock.sleep,
      now: clock.now,
    );

    final at = <DateTime>[];
    for (var i = 0; i < 4; i++) {
      await pacer.run(() async => at.add(clock.now()));
    }

    /* Four things running together must not make four times the requests.
       1.x had four loops each waiting its own half minute, so together they
       asked every seven seconds while each believed it asked every 28. */
    for (var i = 1; i < at.length; i++) {
      final gap = at[i].difference(at[i - 1]);
      expect(gap.inMilliseconds, greaterThanOrEqualTo(4500),
          reason: 'gap $i was ${gap.inMilliseconds}ms');
    }
  });

  test('the first request does not wait', () async {
    final clock = Clock();
    final pacer = Pacer(sleep: clock.sleep, now: clock.now);
    await pacer.run(() async {});
    expect(clock.slept, isEmpty,
        reason:
            'somebody who opens a work should not watch a spinner for half a minute');
  });

  test('everything waits out a cool-off, not only whoever was told', () async {
    final clock = Clock();
    final pacer = Pacer(
      gap: const Duration(seconds: 1),
      sleep: clock.sleep,
      now: clock.now,
    );
    await pacer.run(() async {});
    pacer.slowDown(const Duration(minutes: 5));
    expect(pacer.coolingUntil, isNotNull);

    final began = clock.at;
    await pacer.run(() async {});
    expect(clock.at.difference(began).inMinutes, greaterThanOrEqualTo(5),
        reason: 'a 429 is the archive asking the whole app for room');
  });

  test('a cool-off expires rather than lasting for ever', () async {
    final clock = Clock();
    final pacer = Pacer(sleep: clock.sleep, now: clock.now);
    pacer.slowDown(const Duration(minutes: 1));
    clock.at = clock.at.add(const Duration(minutes: 2));
    expect(pacer.coolingUntil, isNull);
  });

  test('turns are taken in order', () async {
    final clock = Clock();
    final pacer = Pacer(
      gap: const Duration(seconds: 1),
      sleep: clock.sleep,
      now: clock.now,
    );
    final order = <int>[];
    await Future.wait([
      for (var i = 0; i < 5; i++) pacer.run(() async => order.add(i)),
    ]);
    expect(order, [0, 1, 2, 3, 4],
        reason: 'a queue that reorders is a queue nobody can reason about');
  });

  group('the gap is a mean, not a metronome', () {
    test('it varies', () {
      final random = math.Random(7);
      final gaps = {
        for (var i = 0; i < 40; i++) nextGap(random: random).inMilliseconds,
      };
      expect(gaps.length, greaterThan(20),
          reason:
              'a request exactly every 28 seconds is the easiest thing to notice');
    });

    test('but stays within reach of it', () {
      final random = math.Random(7);
      for (var i = 0; i < 200; i++) {
        final ms = nextGap(random: random).inMilliseconds;
        expect(
            ms, greaterThanOrEqualTo((minGap.inMilliseconds * 0.45).round()));
        expect(ms, lessThanOrEqualTo((minGap.inMilliseconds * 2.5).round()));
      }
    });
  });
}
