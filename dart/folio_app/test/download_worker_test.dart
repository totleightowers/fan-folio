import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_foreground_task/flutter_foreground_task_platform_interface.dart';
import 'package:folio_app/downloads.dart';
import 'package:folio_app/download_worker.dart';
import 'package:folio_app/library.dart';
import 'package:folio_app/remote_downloads.dart';
import 'package:folio_app/session.dart';
import 'package:folio_app/worker_diagnostics.dart';
import 'package:folio_core/folio_core.dart' as core;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'test_database.dart';

class WorkerPlatform extends FlutterForegroundTaskPlatform {
  WorkerPlatform(this.worker);
  final DownloadWorker worker;
  @override
  Future<bool> get isRunningService async => true;
  @override
  void sendDataToTask(Object data) {
    unawaited(worker.receive(Map<String, dynamic>.from(data as Map)));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(prepareTestDatabase);
  final fixture = File('../../test/fixtures/work-page.html').readAsStringSync();
  test('service completes a download after UI disposal and a new UI reconnects to the same queue', () async {
    final scratch = await Directory.systemTemp.createTemp('folio-worker');
    final library = await Library.create('${scratch.path}/library.db');
    final gate = Completer<void>();
    var now = DateTime(2026);
    var requests = 0;
    final engine = LocalDownloads(
      library: library,
      pacerFactory: (checkpoint) => core.Pacer(
        now: () => now,
        sleep: (d) async {
          now = now.add(d);
        },
        checkpoint: checkpoint,
      ),
      clientFactory: (pacer) => core.ArchiveClient(
        pacer: pacer,
        http_: MockClient((_) async {
          requests++;
          await gate.future;
          return http.Response.bytes(
            utf8.encode(fixture),
            200,
            headers: {'content-type': 'text/html; charset=utf-8'},
          );
        }),
      ),
    );
    final messages = <Map<String, Object?>>[];
    final worker = DownloadWorker(
      engine,
      send: (data) {
        messages.add(data);
        for (final callback in FlutterForegroundTask.dataCallbacks.toList()) {
          callback(data);
        }
      },
      whenIdle: () async {},
    );
    final platform = FlutterForegroundTaskPlatform.instance;
    FlutterForegroundTaskPlatform.instance = WorkerPlatform(worker);
    RemoteDownloads? ui;
    try {
      await worker.start();
      ui = RemoteDownloads(library: library, session: Session.none);
      await ui.restore();
      await ui.addByLink('https://archiveofourown.org/works/58374928');
      ui.dispose();
      ui = null;
      gate.complete();
      for (var i = 0; i < 300 && engine.busy; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      await engine.flush();
      expect(engine.busy, isFalse);
      expect(engine.jobs.single.added, 1);
      expect(await library.chapterHtml('58374928', 1), isNotEmpty);
      final before = requests;
      ui = RemoteDownloads(library: library, session: Session.none);
      await ui.restore();
      expect(ui.jobs.single.added, 1);
      expect(
        requests,
        before,
        reason: 'reconnecting must not create another queue',
      );
      await worker.receive({
        'id': 'same-action',
        'method': 'addWorks',
        'args': {'label': 'saved', 'ids': <String>[]},
      });
      final count = engine.jobs.length;
      await worker.receive({
        'id': 'same-action',
        'method': 'addWorks',
        'args': {'label': 'saved', 'ids': <String>[]},
      });
      expect(
        engine.jobs.length,
        count,
        reason: 'duplicate delivery must not repeat a mutation',
      );
      expect(messages.any((m) => m['type'] == 'state'), isTrue);
    } finally {
      if (!gate.isCompleted) gate.complete();
      ui?.dispose();
      await worker.close();
      FlutterForegroundTaskPlatform.instance = platform;
      await library.close();
      await scratch.delete(recursive: true);
    }
  });

  test(
    'Android timeout checkpoints paused work and rejects late commands',
    () async {
      final scratch = await Directory.systemTemp.createTemp('folio-timeout');
      final library = await Library.create('${scratch.path}/library.db');
      final requested = Completer<void>();
      final release = Completer<void>();
      var now = DateTime(2026);
      var requests = 0;
      LocalDownloads makeEngine() => LocalDownloads(
        library: library,
        pacerFactory: (checkpoint) => core.Pacer(
          now: () => now,
          sleep: (d) async {
            now = now.add(d);
          },
          checkpoint: checkpoint,
        ),
        clientFactory: (pacer) => core.ArchiveClient(
          pacer: pacer,
          http_: MockClient((_) async {
            requests++;
            if (!requested.isCompleted) requested.complete();
            await release.future;
            throw http.ClientException('Service stopped');
          }),
        ),
      );
      final replies = <Map<String, Object?>>[];
      final first = DownloadWorker(
        makeEngine(),
        send: replies.add,
        whenIdle: () async {},
      );
      DownloadWorker? restored;
      try {
        await first.start();
        await first.receive({
          'id': 'add',
          'method': 'addWorks',
          'args': {
            'label': 'Timeout test',
            'ids': ['58374928', '58374929'],
          },
        });
        await requested.future.timeout(const Duration(seconds: 2));
        await first.close(timeout: true);
        release.complete();
        await Future<void>.delayed(const Duration(milliseconds: 30));
        final before = requests;
        restored = DownloadWorker(
          makeEngine(),
          send: replies.add,
          whenIdle: () async {},
        );
        await restored.start();
        await Future<void>.delayed(const Duration(milliseconds: 30));
        expect(restored.engine.jobs.single.state, core.JobState.paused);
        expect(restored.engine.jobs.single.total, 2);
        expect(restored.engine.jobs.single.done, 0);
        expect(
          requests,
          before,
          reason: 'Android timeout must not silently restart downloads',
        );
        await first.receive({
          'id': 'too-late',
          'method': 'addWorks',
          'args': {
            'label': 'Late',
            'ids': ['999'],
          },
        });
        expect(replies.last['id'], 'too-late');
        expect(replies.last['error'], contains('stopping'));
        expect(restored.engine.jobs, hasLength(1));
      } finally {
        if (!release.isCompleted) release.complete();
        await restored?.close();
        // The first worker was closed explicitly before reconstructing state.
        if (restored == null) await first.close();
        await library.close();
        await scratch.delete(recursive: true);
      }
    },
  );

  test(
    'diagnostics exclude strings and rotate without losing the current record',
    () async {
      final scratch = await Directory.systemTemp.createTemp('folio-worker-log');
      try {
        final file = File('${scratch.path}/worker.jsonl');
        final log = WorkerDiagnostics(file);
        await log.event('checkpoint', {
          'count': 3,
          'busy': true,
          'cookie': 'secret',
          'url': 'https://example.org/story',
        });
        var text = await file.readAsString();
        expect(text, contains('"count":3'));
        expect(text, contains('"busy":true'));
        expect(text, isNot(contains('secret')));
        expect(text, isNot(contains('example.org')));
        await file.writeAsString('x' * (1024 * 1024 + 1));
        await log.event('restart');
        text = await file.readAsString();
        expect(jsonDecode(text)['event'], 'restart');
        expect(await File('${file.path}.previous').exists(), isTrue);
      } finally {
        await scratch.delete(recursive: true);
      }
    },
  );
}
