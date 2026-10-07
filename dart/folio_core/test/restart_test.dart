import 'dart:async';

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

void main() {
  SavedJob saved(JobState state, {bool open = false}) => SavedJob(
        author: 'Fixture author',
        part: 'works',
        state: state,
        workIds: ['3'],
        unfinished: [],
        total: 3,
        added: 2,
        failed: 0,
        open: open,
        page: 2,
        pages: 4,
        rounds: 0,
      );

  test('restoration preserves pause, totals, and explicit resume', () async {
    final requests = <String>[];
    final queue =
        JobQueue(runTask: (id) async => requests.add(id), wait: (_) async {});
    final id = queue.restore(saved(JobState.paused), start: false);
    queue.startRestored();
    await Future<void>.delayed(Duration.zero);
    expect(requests, isEmpty);
    expect(queue.list().single.total, 3);
    expect(queue.list().single.done, 2);
    expect(queue.resume(id), isTrue);
    await Future<void>.delayed(Duration.zero);
    expect(requests, ['3']);
    expect(queue.list().single.done, 3);
    expect(queue.list().single.added, 3);
    expect(queue.save().single.total, 3);
    final again = JobQueue(runTask: (_) async {}, wait: (_) async {});
    again.restore(queue.save().single);
    expect(again.list().single.done, 3);
  });

  test('an interrupted listing cannot pretend its producer is still running',
      () {
    final queue = JobQueue(runTask: (_) async {}, wait: (_) async {});
    queue.restore(saved(JobState.listing, open: true), start: false);
    final job = queue.list().single;
    expect(job.state, JobState.paused);
    expect(job.open, isFalse);
    expect(job.say, contains('Listing interrupted'));
  });

  test('more than forty pending jobs are all retained', () {
    final queue = JobQueue(runTask: (_) async {}, wait: (_) async {});
    for (var i = 0; i < 55; i++) {
      queue.restore(saved(JobState.paused), start: false);
    }
    expect(queue.save(), hasLength(55));
  });

  test('cooldown extended during a wait is rechecked before dispatch',
      () async {
    var now = DateTime(2026);
    var sleeps = 0;
    late Pacer pacer;
    pacer = Pacer(
        now: () => now,
        sleep: (duration) async {
          now = now.add(duration);
          if (++sleeps == 1) pacer.slowDown(const Duration(minutes: 5));
        });
    pacer.slowDown(const Duration(minutes: 1));
    final start = now;
    await pacer.run(() async {});
    expect(now.difference(start), const Duration(minutes: 6));
  });

  test(
      'rate-limit state survives a fresh pacer and is persisted before dispatch',
      () async {
    var now = DateTime(2026);
    final old = Pacer(now: () => now)..slowDown(const Duration(minutes: 5));
    var checkpointed = false;
    final next = Pacer(
        now: () => now,
        sleep: (d) async {
          now = now.add(d);
        },
        checkpoint: () async {
          checkpointed = true;
        });
    next.restore(old.save());
    await next.run(() async {
      expect(now, DateTime(2026).add(const Duration(minutes: 5)));
      expect(checkpointed, isTrue);
    });
  });
}
