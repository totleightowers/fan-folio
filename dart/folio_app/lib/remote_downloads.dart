import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'download_state.dart';
import 'downloads.dart';
import 'keep_working.dart';
import 'library.dart';
import 'session.dart';

/// UI proxy. It never owns a queue, network client or pacing clock.
class RemoteDownloads extends Downloads {
  RemoteDownloads({required this.library, required Session session})
    : _session = session,
      super.base() {
    FlutterForegroundTask.addTaskDataCallback(_receive);
    _watch = Timer.periodic(
      const Duration(seconds: 5),
      (_) => unawaited(_checkWorker()),
    );
  }
  @override
  final Library library;
  Session _session;
  List<core.JobView> _jobs = const [];
  DateTime? _cooling;
  String? _problem;
  bool _disposed = false;
  bool _connected = false;
  Future<void>? _connecting;
  Timer? _watch;
  int _sequence = 0;
  final String _connection = DateTime.now().microsecondsSinceEpoch.toString();
  final Map<String, Completer<Object?>> _pending = {};
  final Map<String, void Function(int, int?, int)> _progress = {};
  @override
  List<core.JobView> get jobs => _jobs;
  @override
  Session get session => _session;
  @override
  String? get signedInAs => _session.username;
  @override
  bool get canAct => signedInAs != null;
  @override
  String? get storageProblem => _problem;
  @override
  DateTime? get cooling => _cooling;
  @override
  bool get busy => _jobs.any(
    (j) => [
      core.JobState.running,
      core.JobState.pausing,
      core.JobState.queued,
      core.JobState.listing,
    ].contains(j.state),
  );

  void _state(Map data) {
    _jobs = jobsFromState(data);
    _cooling = DateTime.tryParse(data['cooling'] as String? ?? '');
    _session = Session(
      cookies: _session.cookies,
      username: data['username'] as String?,
      userAgent: _session.userAgent,
    );
    _problem = data['problem'] as String?;
    if (!_disposed) notifyListeners();
  }

  void _receive(Object raw) {
    if (_disposed || raw is! Map) return;
    switch (raw['type']) {
      case 'state':
        _state(raw);
      case 'reply':
        final waiter = _pending.remove(raw['id']);
        if (waiter == null) return;
        _progress.remove(raw['id']);
        if (raw['error'] != null) {
          waiter.completeError(StateError(raw['error'] as String));
        } else {
          waiter.complete(raw['value']);
        }
      case 'progress':
        _progress[raw['id']]?.call(
          raw['page'] as int,
          raw['pages'] as int?,
          raw['found'] as int,
        );
      case 'stopping':
        _connected = false;
      case 'stopped':
        _connected = false;
        if (raw['timeout'] == true || _pending.isNotEmpty) {
          _fail(
            'Android stopped the download worker. Progress is saved; reopen Downloads to resume.',
          );
        }
      case 'fatal':
        _fail(raw['error'] as String);
    }
  }

  void _fail(String message) {
    _connected = false;
    _problem = message;
    final waiting = _pending.values.toList();
    _pending.clear();
    _progress.clear();
    for (final p in waiting) {
      p.completeError(StateError(message));
    }
    if (!_disposed) notifyListeners();
  }

  Future<void> _checkWorker() async {
    if (_disposed || !_connected) return;
    if (!await FlutterForegroundTask.isRunningService && !_disposed) {
      _connected = false;
      if (busy || _pending.isNotEmpty)
        _fail(
          'Downloads were interrupted. The queue is saved; resume it from Downloads.',
        );
    }
  }

  Future<void> _connect() {
    if (_disposed) return Future.error(StateError('Download view closed'));
    return _connecting ??= _open().whenComplete(() => _connecting = null);
  }

  Future<void> _open() async {
    if (_connected && await FlutterForegroundTask.isRunningService) return;
    if (!await FlutterForegroundTask.isRunningService) {
      await FlutterForegroundTask.requestNotificationPermission();
      final result = await FlutterForegroundTask.startService(
        serviceTypes: [ForegroundServiceTypes.dataSync],
        notificationTitle: 'Fan Folio Preview',
        notificationText: 'Restoring downloads',
        notificationButtons: [
          const NotificationButton(id: 'pause', text: 'Pause'),
        ],
        callback: downloadServiceEntry,
      );
      if (result is ServiceRequestFailure)
        throw StateError('Android could not start downloads: ${result.error}');
    }
    // Only the read-only handshake may be retried. Never replay an archive action.
    for (var attempt = 0; attempt < 30; attempt++) {
      try {
        await _send('hello', const {}, deadline: const Duration(seconds: 1));
        if (_disposed) throw StateError('Download view closed');
        _connected = true;
        return;
      } on TimeoutException {
        if (_disposed) rethrow;
      }
    }
    throw StateError(
      'Download worker did not respond. Try again or export diagnostics.',
    );
  }

  Future<Object?> _send(
    String method,
    Map<String, Object?> args, {
    void Function(int, int?, int)? progress,
    Duration? deadline,
  }) async {
    final id = '$_connection:${++_sequence}';
    final response = Completer<Object?>();
    _pending[id] = response;
    if (progress != null) _progress[id] = progress;
    try {
      FlutterForegroundTask.sendDataToTask({
        'id': id,
        'method': method,
        'args': args,
      });
      return await (deadline == null
          ? response.future
          : response.future.timeout(deadline));
    } finally {
      _pending.remove(id);
      _progress.remove(id);
    }
  }

  Future<Object?> _call(
    String method, [
    Map<String, Object?> args = const {},
    void Function(int, int?, int)? progress,
  ]) async {
    await _connect();
    return _send(method, args, progress: progress);
  }

  void _background(Future<dynamic> task) {
    unawaited(
      task.then<void>(
        (_) {},
        onError: (Object e, StackTrace s) {
          if (!_disposed) {
            _problem = '$e';
            notifyListeners();
          }
        },
      ),
    );
  }

  @override
  Future<void> restore() async {
    if (await FlutterForegroundTask.isRunningService) {
      try {
        await _connect();
      } catch (e) {
        _problem = '$e';
      }
      return;
    }
    // Read-only preview of persisted state. This engine is never started.
    final held = LocalDownloads(library: library, session: _session);
    try {
      await held.restore();
      _state(downloadState(held));
    } finally {
      held.dispose();
    }
  }

  @override
  void start() {
    if (busy) _background(_connect());
  }

  @override
  Future<void> flush() async {
    if (_connected) await _call('flush');
  }

  @override
  Future<void> useThisDevicesAgent() async {
    try {
      final agent = await InAppWebViewController.getDefaultUserAgent();
      if (agent.isEmpty) return;
      _session = Session(
        cookies: _session.cookies,
        username: _session.username,
        userAgent: agent,
      );
      if (await FlutterForegroundTask.isRunningService) {
        await _call('agent', {'agent': agent});
      } else {
        await _session.save();
      }
    } catch (_) {
      /* Retain the persisted device agent if unavailable. */
    }
  }

  @override
  Future<void> refreshCookies() async {
    try {
      final jar = await CookieManager.instance().getCookies(
        url: WebUri(core.origin),
      );
      if (jar.isEmpty) return;
      final cookies = {for (final c in jar) c.name: '${c.value}'};
      _session = Session(
        cookies: cookies,
        username: _session.username,
        userAgent: _session.userAgent,
      );
      if (await FlutterForegroundTask.isRunningService) {
        await _call('session', {
          'cookies': cookies,
          'username': _session.username,
        });
      } else {
        await _session.save();
      }
    } catch (_) {
      /* Keep the previous session. */
    }
  }

  @override
  Future<int> addByLink(String link) async =>
      await _call('addByLink', {'link': link}) as int;
  @override
  Future<int> addWorks(String label, List<String> workIds) async =>
      await _call('addWorks', {'label': label, 'ids': workIds}) as int;
  @override
  Future<int> syncBookmarks() async => await _call('syncBookmarks') as int;
  @override
  Future<int> syncPerson(
    String byline, {
    required bool bookmarks,
    bool andFetch = true,
    void Function(int, int?, int)? onProgress,
  }) async => await _call('syncPerson', {
    'byline': byline,
    'bookmarks': bookmarks,
    'andFetch': andFetch,
  }, onProgress) as int;
  @override
  Future<core.ListingCost> costOfAuthor(String byline) async {
    final cost = await _call('costOfAuthor', {'byline': byline}) as Map;
    return core.ListingCost(
      pages: cost['pages'] as int,
      works: cost['works'] as int,
      minutes: cost['minutes'] as int,
    );
  }

  @override
  Future<int> addAuthor(String byline) async =>
      await _call('addAuthor', {'byline': byline}) as int;
  @override
  Future<bool> leaveKudos(String workId) async =>
      await _call('kudos', {'workId': workId}) as bool;
  @override
  Future<void> bookmark(
    String workId, {
    String notes = '',
    String tags = '',
    bool private = false,
    bool rec = false,
  }) async {
    await _call('bookmark', {
      'workId': workId,
      'notes': notes,
      'tags': tags,
      'private': private,
      'rec': rec,
    });
  }

  @override
  Future<void> comment(String workId, String text) async {
    await _call('comment', {'workId': workId, 'text': text});
  }

  @override
  Future<Uint8List?> fetchPicture(String workId, String src) async {
    final value = await _call('picture', {'workId': workId, 'src': src});
    return value == null ? null : base64Decode(value as String);
  }

  @override
  Future<int> fetchPicturesFor(String workId) async =>
      await _call('pictures', {'workId': workId}) as int;
  bool _control(String method, int id) {
    _background(_call(method, {'job': id}));
    return true;
  }

  @override
  bool pause(int id) => _control('pause', id);
  @override
  bool resume(int id) => _control('resume', id);
  @override
  bool stop(int id) => _control('stop', id);
  @override
  bool remove(int id) => _control('remove', id);
  @override
  bool rerun(int id) => _control('rerun', id);
  @override
  Future<void> adoptSession(Map<String, String> cookies, String who) async {
    await useThisDevicesAgent();
    await _call('session', {'cookies': cookies, 'username': who});
    _session = Session(
      cookies: cookies,
      username: who,
      userAgent: _session.userAgent,
    );
    notifyListeners();
  }

  @override
  Future<void> signOut() async {
    await _call('signOut');
    _session = Session.none;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _watch?.cancel();
    FlutterForegroundTask.removeTaskDataCallback(_receive);
    _fail(
      'The screen closed. Any accepted downloads continue in the background.',
    );
    // Deliberately no stopService, client close or queue mutation.
    super.dispose();
  }
}
