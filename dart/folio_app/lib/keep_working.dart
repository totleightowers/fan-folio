import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:folio_core/folio_core.dart' as core;
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'download_worker.dart';
import 'downloads.dart';
import 'library.dart';
import 'session.dart';
import 'worker_diagnostics.dart';

bool get supportsDownloadService =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

void prepareDownloadService() {
  if (!supportsDownloadService) return;
  FlutterForegroundTask.initCommunicationPort();
  FlutterForegroundTask.init(
    androidNotificationOptions: AndroidNotificationOptions(
      channelId: 'fanfolio_downloads',
      channelName: 'Downloading',
      channelDescription: 'Progress of downloads running in the background.',
      channelImportance: NotificationChannelImportance.LOW,
      priority: NotificationPriority.LOW,
      onlyAlertOnce: true,
    ),
    iosNotificationOptions: const IOSNotificationOptions(),
    foregroundTaskOptions: ForegroundTaskOptions(
      eventAction: ForegroundTaskEventAction.repeat(5000),
      allowWakeLock: true,
      allowWifiLock: true,
      allowAutoRestart: true,
      stopWithTask: false,
      autoRunOnBoot: false,
    ),
  );
}

@pragma('vm:entry-point')
void downloadServiceEntry() {
  FlutterForegroundTask.setTaskHandler(DownloadTaskHandler());
}

class DownloadTaskHandler extends TaskHandler {
  DownloadWorker? _worker;
  Library? _library;
  WorkerDiagnostics? _diagnostics;
  Future<void>? _ready;
  int _ticks = 0;
  bool _stopping = false;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) {
    return _ready = _open(starter);
  }

  Future<void> _open(TaskStarter starter) async {
    try {
      _diagnostics = WorkerDiagnostics(await WorkerDiagnostics.location());
      await _diagnostics!.event('worker_start', {
        'system': starter == TaskStarter.system,
      });
      // A separate connection: closing the service must not close the UI's DB.
      final library = await Library.openExisting(null, false);
      if (library == null) throw StateError('No preview library is available.');
      _library = library;
      final engine = LocalDownloads(
        library: library,
        session: await Session.load(),
      );
      _worker = DownloadWorker(
        engine,
        send: FlutterForegroundTask.sendDataToMain,
        whenIdle: () async {
          await FlutterForegroundTask.stopService();
        },
      );
      await _worker!.start();
      await _notice();
    } catch (_) {
      await _diagnostics?.event('worker_start_failed');
      FlutterForegroundTask.sendDataToMain({
        'type': 'fatal',
        'error': 'The download worker could not start. Export its diagnostic report from Settings.',
      });
      // Do not wait for onDestroy here: it waits for initialization to settle.
      unawaited(FlutterForegroundTask.stopService().then((_) {}));
    }
  }

  Future<void> _notice() async {
    final engine = _worker?.engine;
    if (engine == null || _stopping) return;
    final active = engine.jobs.where(
      (j) => [
        core.JobState.listing,
        core.JobState.queued,
        core.JobState.running,
        core.JobState.pausing,
      ].contains(j.state),
    );
    final total = active.fold<int>(0, (n, j) => n + j.total);
    final done = active.fold<int>(0, (n, j) => n + j.done);
    final listing = active.any((j) => j.open);
    final text = engine.storageProblem != null
        ? 'Paused: check device storage'
        : engine.cooling != null
        ? 'Waiting for the archive — downloads are saved'
        : engine.busy
        ? listing
              ? '$done processed · finding works'
              : '$done of $total processed'
        : 'Finishing archive requests';
    await FlutterForegroundTask.updateService(
      notificationTitle: 'Fan Folio Preview',
      notificationText: text,
    );
  }

  @override
  void onReceiveData(Object data) {
    if (_stopping || data is! Map) return;
    unawaited(_receive(Map<String, dynamic>.from(data)));
  }

  Future<void> _receive(Map<String, dynamic> data) async {
    await _ready;
    final worker = _worker;
    if (worker == null || _stopping) return;
    await _diagnostics?.event('command_received');
    await worker.receive(data);
    await _notice();
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    if (_stopping) return;
    _worker?.publish();
    unawaited(_notice());
    if (++_ticks % 12 == 0) {
      final worker = _worker;
      if (worker != null) {
        unawaited(
          _diagnostics?.event('heartbeat', {
            'busy': worker.engine.busy,
            'jobs': worker.engine.jobs.length,
            'saved': worker.engine.jobs.fold<int>(0, (n, j) => n + j.added),
            'failed': worker.engine.jobs.fold<int>(0, (n, j) => n + j.failed),
            'progressAgeSeconds': DateTime.now()
                .difference(worker.lastProgress)
                .inSeconds,
          }),
        );
      }
    }
  }

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    _stopping = true;
    await _ready;
    await _diagnostics?.event('worker_stop', {'timeout': isTimeout});
    try {
      await _worker?.close(timeout: isTimeout);
    } catch (_) {
      await _diagnostics?.event('worker_checkpoint_failed');
    } finally {
      FlutterForegroundTask.sendDataToMain({
        'type': 'stopped',
        'timeout': isTimeout,
      });
      await _library?.db.close();
    }
  }

  @override
  void onNotificationButtonPressed(String id) {
    if (id == 'pause' && !_stopping) {
      unawaited(
        _worker?.receive({
          'id': 'notification:${DateTime.now().microsecondsSinceEpoch}',
          'method': 'pauseAll',
          'args': <String, dynamic>{},
        }),
      );
    }
  }

  @override
  void onNotificationPressed() => FlutterForegroundTask.launchApp();
}
