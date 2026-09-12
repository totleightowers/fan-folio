import 'package:flutter/foundation.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'downloads.dart';

/// Asking Android not to stop the app while there is work owed.
///
/// A download is an hour of one request every half minute, and a backgrounded
/// app is not allowed to make them. Without this a long walk dies the moment
/// somebody answers a message, which on a phone is most of the time — and it
/// dies silently, which is the worse half.
///
/// This only holds the process open and shows what is going on. The queue
/// stays in the app's own isolate, next to the library it is writing to,
/// because a second isolate means a second connection to the same SQLite file
/// and a second idea of whose turn it is with the archive. 1.x made the same
/// choice for the same reason: the page kept its queue and the shell only
/// asked Android for room.
class KeepWorking {
  KeepWorking(this.downloads) {
    downloads.addListener(_changed);
  }

  final Downloads downloads;
  bool _running = false;
  String _said = '';

  static bool get _supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  /// Set up the channel once, before anything asks for the service.
  static void prepare() {
    if (!_supported) return;
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'fanfolio_downloads',
        channelName: 'Downloading',
        channelDescription:
            'Shown while works are being fetched, so Android leaves the app '
            'running.',
        // low: this is a progress note, not news. A download that pings is a
        // download somebody turns off.
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
        onlyAlertOnce: true,
      ),
      iosNotificationOptions: const IOSNotificationOptions(),
      foregroundTaskOptions: ForegroundTaskOptions(
        // nothing to run over there: the work is in this isolate
        eventAction: ForegroundTaskEventAction.nothing(),
        allowWakeLock: true,
        allowWifiLock: true,
      ),
    );
  }

  Future<void> _changed() async {
    if (!_supported) return;
    final busy = downloads.busy;
    final saying = _summary();

    if (busy && !_running) {
      _running = true;
      _said = saying;
      /* Asked for the first time it is actually needed rather than at
         startup: a reader who never downloads anything should never be asked
         whether this app may notify them. */
      await FlutterForegroundTask.requestNotificationPermission();
      await FlutterForegroundTask.startService(
        serviceTypes: [ForegroundServiceTypes.dataSync],
        notificationTitle: 'Fan Folio',
        notificationText: saying,
      );
      return;
    }

    if (busy && saying != _said) {
      _said = saying;
      /* Kept truthful rather than kept up to the second. A notification that
         still says "downloading" an hour after the last work arrived is how
         an app teaches somebody to ignore it. */
      await FlutterForegroundTask.updateService(notificationText: saying);
      return;
    }

    if (!busy && _running) {
      _running = false;
      await FlutterForegroundTask.stopService();
    }
  }

  /// One line about everything, because a notification has one line.
  String _summary() {
    final jobs = downloads.jobs.where(
      (job) =>
          job.state != core.JobState.done &&
          job.state != core.JobState.cancelled,
    );
    if (jobs.isEmpty) return 'Finishing up';

    final done = jobs.fold<int>(0, (n, job) => n + job.done);
    final total = jobs.fold<int>(0, (n, job) => n + job.total);
    final open = jobs.any((job) => job.open);

    final cooling = downloads.cooling;
    if (cooling != null) {
      final minutes = cooling.difference(DateTime.now()).inMinutes;
      return minutes < 1
          ? 'Waiting a moment for the archive'
          : 'Waiting $minutes min — the archive asked for room';
    }

    if (total == 0) return 'Reading the list';
    return open ? '$done of $total so far' : '$done of $total';
  }

  void dispose() {
    downloads.removeListener(_changed);
    if (_running && _supported) FlutterForegroundTask.stopService();
  }
}
