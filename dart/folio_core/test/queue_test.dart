import 'dart:async';

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

final settle = () => Future<void>.delayed(Duration.zero);

/// A queue whose waits are controllable, so a test is not an hour long.
class Harness {
  Harness({Future<void> Function(String)? runTask}) {
    queue = JobQueue(
      runTask: runTask ?? (id) async => order.add(id),
      wait: (_) {
        final completer = Completer<void>();
        _release = completer;
        return completer.future;
      },
      onEvent: (type, job, jobs) => events.add(type),
      shouldRetry: (m) => m != null && m.contains('busy'),
      retryWait: (_) => Duration.zero,
    );
  }

  late final JobQueue queue;
  final List<String> order = [];
  final List<String> events = [];
  Completer<void>? _release;

  Future<void> tick() async {
    _release?.complete();
    _release = null;
    await settle();
  }
}

void main() {
  test('a job runs every work it was given', () async {
    final h = Harness();
    h.queue.add(author: 'ellen', part: 'works', workIds: ['1', '2', '3']);
    await settle();
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.order, ['1', '2', '3']);
    expect(h.queue.list().single.state, JobState.done);
  });

  test('opening an author twice does not download them twice', () async {
    final h = Harness();
    final first = h.queue.add(author: 'ellen', part: 'works', workIds: ['1']);
    final again = h.queue.add(author: 'ellen', part: 'works', workIds: ['2']);
    expect(again, first,
        reason: 'the same author and the same half is one job');
    expect(h.queue.list().length, 1);
    expect(h.queue.list().single.total, 2, reason: 'and it grew');
  });

  test('a job reading an index stands there saying so', () async {
    final h = Harness();
    final id = h.queue.add(author: 'ellen', part: 'works', open: true);
    await settle();
    expect(h.queue.list().single.state, JobState.listing,
        reason: 'a queue showing nothing looks broken at exactly the moment '
            'somebody is watching to see whether their tap did anything');

    h.queue.append(id, ['1']);
    await settle();
    expect(h.order, ['1'],
        reason: 'the first page is queued the moment it lands');
    /* And then back to waiting rather than reporting itself finished: out of
       work but not out of list, and the next page to land wakes it. */
    expect(h.queue.list().single.state, JobState.listing);
  });

  test('a sealed walk that got everything is finished', () async {
    final h = Harness();
    final id = h.queue.add(author: 'ellen', part: 'works', open: true);
    await settle();
    h.queue.seal(id);
    await settle();
    expect(h.queue.list().single.state, JobState.done,
        reason: 'a job left open by a walk that failed sits saying it is '
            'still reading for ever');
  });

  test('one job runs at a time, because two would double the rate', () async {
    final h = Harness();
    h.queue.add(author: 'a', part: 'works', workIds: ['1', '2']);
    h.queue.add(author: 'b', part: 'works', workIds: ['3']);
    await settle();
    expect(h.queue.list().where((j) => j.state == JobState.running).length, 1);
  });

  test('a job told to start now runs alongside what is going', () async {
    final h = Harness();
    h.queue.add(author: 'a', part: 'works', workIds: ['1', '2']);
    final b = h.queue.add(author: 'b', part: 'works', workIds: ['3', '4']);
    await settle();
    h.queue.startNow(b);
    await settle();
    expect(h.queue.list().where((j) => j.state == JobState.running).length, 2,
        reason: 'the reader is spending their own account\'s goodwill and has '
            'said so by pressing this');
  });

  test('a paused job takes no more turns until it is resumed', () async {
    final h = Harness();
    final id =
        h.queue.add(author: 'a', part: 'works', workIds: ['1', '2', '3']);
    await settle();
    h.queue.pause(id);
    await h.tick();
    final doneWhilePaused = h.order.length;
    await h.tick();
    expect(h.order.length, doneWhilePaused,
        reason: 'it stopped after the one in flight');
    expect(h.queue.list().single.state, JobState.paused);

    h.queue.resume(id);
    await settle();
    await h.tick();
    await h.tick();
    expect(h.order.length, greaterThan(doneWhilePaused));
  });

  test('a walk asks whether it may take another turn', () async {
    final h = Harness();
    final id = h.queue.add(author: 'a', part: 'works', open: true);
    await settle();
    expect(await h.queue.waitUntilRunnable(id), isTrue);

    /* Pause used to stop the downloading and leave the walk asking the archive
       for page after page: the queue honoured it and the walk had never heard
       of it. */
    h.queue.stop(id);
    expect(await h.queue.waitUntilRunnable(id), isFalse);
    expect(h.queue.isStopped(id), isTrue);
  });

  test('a transient failure is retried and a refusal is not', () async {
    var calls = 0;
    final h = Harness(runTask: (id) async {
      calls++;
      if (id == '1' && calls < 3) throw Exception('archive busy');
      if (id == '2') throw Exception('no such work');
    });
    final id = h.queue.add(author: 'a', part: 'works', workIds: ['1', '2']);
    await settle();
    for (var i = 0; i < 8; i++) {
      await h.tick();
    }

    final job = h.queue.list().single;
    expect(job.added, 1, reason: 'the busy one eventually arrived');
    expect(job.failed, 1, reason: 'and the deleted one did not');
    expect(job.unfinished, 0,
        reason: 'a work that is gone is gone; only a timeout is owed');
    expect(h.queue.isStopped(id), isFalse);
  });

  test('what ran out of retries is still owed', () async {
    final h = Harness(runTask: (id) async => throw Exception('archive busy'));
    h.queue.add(author: 'a', part: 'works', workIds: ['1']);
    await settle();
    for (var i = 0; i < 10; i++) {
      await h.tick();
    }
    expect(h.queue.list().single.unfinished, 1,
        reason: 'a restart should pick it up rather than the job reporting '
            'nothing downloaded and vanishing');
  });

  test('a job is not finished while the works are still missing', () async {
    var asked = 0;
    final queue = JobQueue(
      runTask: (_) async {},
      wait: (_) async {},
      verify: (ids) async => asked++ == 0 ? ['2'] : const [],
    );
    queue.add(author: 'a', part: 'works', workIds: ['1', '2']);
    await Future<void>.delayed(const Duration(milliseconds: 20));

    /* A fetch can end having stored a description and no text, so "the task
       did not throw" and "the work arrived" are different statements. */
    final job = queue.list().single;
    expect(job.state, JobState.done);
    expect(job.rounds, greaterThan(1),
        reason: 'it went round again for the one missing');
  });

  test('a work the archive will not give up does not loop for ever', () async {
    final queue = JobQueue(
      runTask: (_) async {},
      wait: (_) async {},
      verify: (_) async => ['1'],
      maxRounds: 3,
    );
    queue.add(author: 'a', part: 'works', workIds: ['1']);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    final job = queue.list().single;
    expect(job.state, JobState.done);
    expect(job.rounds, 3);
    expect(job.unfinished, 1, reason: 'owed, not delivered');
  });

  test('a record remembers how much it was ever about', () async {
    final h = Harness();
    h.queue.add(author: 'a', part: 'works', workIds: ['1', '2', '3']);
    await settle();
    await h.tick();
    await h.tick();
    await h.tick();

    final saved = h.queue.save().single;
    expect(saved.total, 3);
    expect(saved.added, 3);

    final other = Harness();
    other.queue.restore(saved);
    final record = other.queue.list().single;
    expect(record.total, 3,
        reason: 'not the length of a list it has finished with');
    expect(other.queue.save().single.total, 3,
        reason: 'and saving it again does not lose it');
  });

  test('a walk closed halfway is not a walk forgotten', () async {
    final h = Harness();
    final id = h.queue.add(author: 'ann', part: 'bookmarks', open: true);
    await settle();
    h.queue.note(id, page: 3, pages: 12);

    final saved = h.queue.save().single;
    expect(saved.page, 3);
    expect(saved.pages, 12);
    expect(saved.open, isTrue);
    expect(JobQueue(runTask: (_) async {}, wait: (_) async {}).restore(saved),
        isNotNull);
  });

  test('work that does not end in downloads can still say what it came to',
      () async {
    final h = Harness();
    final id = h.queue
        .add(author: 'Your bookmarks', part: 'the whole list', open: true);
    await settle();
    h.queue.note(id, say: '1,204 bookmarks, 3 no longer bookmarked');
    h.queue.seal(id);
    await settle();

    expect(h.queue.list().single.say, '1,204 bookmarks, 3 no longer bookmarked',
        reason: 'without it the row read "0 of 0" — a job that did nothing, '
            'having read 1,204 pages');
    expect(h.queue.save().single.say, isNotNull,
        reason: 'and it survives a restart');
  });

  test('a finished job can be asked for again', () async {
    final h = Harness(runTask: (_) async => throw Exception('archive busy'));
    final id = h.queue.add(author: 'a', part: 'works', workIds: ['1']);
    await settle();
    for (var i = 0; i < 10; i++) {
      await h.tick();
    }
    expect(h.queue.list().single.unfinished, 1);
    expect(h.queue.rerun(id), isTrue,
        reason: 'a record that cannot be acted on is only half a record');
    expect(h.queue.list().single.state, isNot(JobState.done));
  });

  test('a stopped job stays on the list, saying what happened', () async {
    final h = Harness();
    final id = h.queue.add(author: 'a', part: 'works', workIds: ['1', '2']);
    await settle();
    h.queue.stop(id);
    expect(h.queue.list().single.state, JobState.cancelled);
    expect(h.queue.save(), isEmpty,
        reason: 'but a stopped job is not owed work');
  });

  test('jobs can be reordered', () {
    final h = Harness();
    final a = h.queue.add(author: 'a', part: 'works', workIds: ['1']);
    final b = h.queue.add(author: 'b', part: 'works', workIds: ['2']);
    expect(h.queue.list().map((j) => j.id), [a, b]);
    h.queue.moveUp(b);
    expect(h.queue.list().map((j) => j.id), [b, a]);
    expect(h.queue.moveUp(b), isFalse,
        reason: 'there is nothing above the top');
  });
}
