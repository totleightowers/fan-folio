import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:folio_app/downloads.dart';
import 'package:folio_app/library.dart';
import 'package:folio_core/folio_core.dart' as core;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  late Directory scratch;
  late Library library;
  late DateTime clock;
  final fixture = File('../../test/fixtures/work-page.html').readAsStringSync();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });
  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('folio-preview-journey');
    library = await Library.create('${scratch.path}/library.db');
    clock = DateTime(2026);
  });
  tearDown(() async {
    await library.close();
    await scratch.delete(recursive: true);
  });

  Downloads engine(Future<http.Response> Function(http.Request) respond) =>
      Downloads(
        library: library,
        pacerFactory: (checkpoint) => core.Pacer(
          now: () => clock,
          sleep: (d) async {
            clock = clock.add(d);
          },
          checkpoint: checkpoint,
        ),
        clientFactory: (pacer) =>
            core.ArchiveClient(pacer: pacer, http_: MockClient(respond)),
      );

  Future<void> finished(Downloads downloads) async {
    for (var i = 0; i < 300 && downloads.busy; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(
      downloads.busy,
      isFalse,
      reason:
          'synthetic download did not settle: ${downloads.jobs.map((j) => j.retrying ?? j.lastError).join('; ')}',
    );
    await downloads.flush();
  }

  test(
    'add, save, find, read, close, and return use the same persisted work',
    () async {
      final requests = <Uri>[];
      final downloads = engine((request) async {
        requests.add(request.url);
        return http.Response(
          fixture,
          200,
          headers: {'content-type': 'text/html; charset=utf-8'},
        );
      });
      await downloads.addByLink('https://archiveofourown.org/works/58374928');
      await finished(downloads);
      expect(
        downloads.jobs.single.failed,
        0,
        reason: downloads.jobs.single.lastError,
      );
      final works = await library.works();
      expect(works.single.workId, '58374928');
      expect(works.single.hasText, isTrue);
      expect(await library.chapterHtml('58374928', 1), isNotEmpty);
      expect(requests, isNotEmpty);
      await library.opened('58374928');
      await library.savePlace('58374928', 1, 384);
      downloads.dispose();
      await library.close();
      library = (await Library.openExisting('${scratch.path}/library.db'))!;
      final restored = engine(
        (_) async => fail('completed work was requested again'),
      );
      await restored.restore();
      restored.start();
      await finished(restored);
      expect(restored.jobs.single.added, 1);
      expect(restored.jobs.single.total, 1);
      expect((await library.returnToStory())?.workId, '58374928');
      expect((await library.placeIn('58374928'))?.offset, 384);
      restored.dispose();
    },
  );

  test('cold start retains a paused download and its cooldown without making requests', () async {
    final until = clock.add(const Duration(minutes: 5));
    final job = core.SavedJob(
      author: 'Added by link',
      part: '58374928',
      state: core.JobState.paused,
      workIds: ['58374928'],
      unfinished: [],
      total: 3,
      added: 2,
      failed: 0,
      open: false,
      page: 0,
      pages: null,
      rounds: 0,
    );
    await library.db.insert('meta', {
      'key': 'flutter.downloads.v1',
      'value': jsonEncode({
        'pacer': {'coolUntil': until.millisecondsSinceEpoch},
        'jobs': [job.toJson()],
      }),
    });
    var calls = 0;
    final downloads = engine((_) async {
      calls++;
      expect(clock.isBefore(until), isFalse);
      return http.Response.bytes(
        utf8.encode(fixture),
        200,
        headers: {'content-type': 'text/html; charset=utf-8'},
      );
    });
    await downloads.restore();
    downloads.start();
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(calls, 0);
    expect(downloads.jobs.single.state, core.JobState.paused);
    expect(downloads.jobs.single.done, 2);
    downloads.resume(downloads.jobs.single.id);
    await finished(downloads);
    expect(calls, greaterThan(0));
    expect(downloads.jobs.single.done, 3);
    expect(downloads.jobs.single.total, 3);
    downloads.dispose();
  });

  test('a missing work stays an inspectable failure after reopening', () async {
    final downloads = engine((_) async => http.Response('Not found', 404));
    await downloads.addByLink('58374928');
    await finished(downloads);
    expect(downloads.jobs.single.failed, 1);
    expect(downloads.jobs.single.unfinished, 1);
    expect(downloads.jobs.single.lastError, contains('deleted'));
    downloads.dispose();
    final restored = engine(
      (_) async => fail('failure retried without an explicit request'),
    );
    await restored.restore();
    restored.start();
    await finished(restored);
    expect(restored.jobs.single.failed, 1);
    expect(restored.jobs.single.unfinished, 1);
    restored.dispose();
  });

  test('a reread imported with a stale availability flag still has a return target', () async {
    await library.db.insert('works', {
      'work_id': 'imported',
      'title': 'Offline copy',
      'has_text': 0,
    });
    await library.db.insert('chapters', {
      'work_id': 'imported',
      'number': 1,
      'html': '<p>Still here.</p>',
    });
    await library.opened('imported');
    await library.finish('imported');
    expect((await library.returnToStory())?.workId, 'imported');
    await library.db.update(
      'works',
      {'hidden': 1},
      where: 'work_id = ?',
      whereArgs: ['imported'],
    );
    expect(await library.returnToStory(), isNull);
  });
}
