import 'dart:async';
import 'dart:convert';

import 'package:folio_core/folio_core.dart' as core;

import 'download_state.dart';
import 'downloads.dart';

/// The service owns this engine. A UI connection is only an observer.
class DownloadWorker {
  DownloadWorker(this.engine, {required this.send, required this.whenIdle});
  final LocalDownloads engine;
  final void Function(Map<String, Object?>) send;
  final Future<void> Function() whenIdle;
  final Set<String> _seen = {};
  int _commands = 0;
  bool _closed = false;
  Timer? _idle;
  DateTime lastProgress = DateTime.now();

  Future<void> start() async {
    await engine.restore();
    engine.addListener(_changed);
    engine.start();
    publish();
  }

  void _changed() {
    lastProgress = DateTime.now();
    publish();
  }

  void publish() {
    if (_closed) return;
    send({'type': 'state', ...downloadState(engine)});
    if (engine.busy || _commands != 0) {
      _idle?.cancel();
      _idle = null;
    }
    if (!engine.busy && _commands == 0) {
      _idle ??= Timer(const Duration(seconds: 10), () async {
        _idle = null;
        if (_closed || engine.busy || _commands != 0) return;
        try {
          await engine.flush();
        } catch (_) {
          send({
            'type': 'fatal',
            'error': 'Downloads could not be saved. Check device storage before resuming.',
          });
        }
        // No await between the final state check and closing command intake.
        if (_closed || engine.busy || _commands != 0) return;
        _closed = true;
        send({'type': 'stopping'});
        await whenIdle();
      });
    }
  }

  Future<void> receive(Map<String, dynamic> message) async {
    final id = message['id'] as String;
    if (_closed) {
      send({
        'type': 'reply',
        'id': id,
        'error': 'Download worker is stopping. Please try again.',
      });
      return;
    }
    // Mutating commands are never replayed automatically after a disconnect.
    if (!_seen.add(id)) return;
    if (_seen.length > 256) _seen.remove(_seen.first);
    _commands++;
    _idle?.cancel();
    _idle = null;
    try {
      final value = await _execute(
        message['method'] as String,
        Map<String, dynamic>.from(message['args'] as Map? ?? {}),
        id,
      );
      await engine.flush();
      send({'type': 'reply', 'id': id, 'value': value});
    } catch (error) {
      send({
        'type': 'reply',
        'id': id,
        'error': error is core.ArchiveError ? error.message : '$error',
      });
    } finally {
      _commands--;
      publish();
    }
  }

  Future<Object?> _execute(
    String method,
    Map<String, dynamic> a,
    String id,
  ) async {
    switch (method) {
      case 'hello':
        return null;
      case 'flush':
        await engine.flush();
        return null;
      case 'agent':
        await engine.setAgent(a['agent'] as String);
        return null;
      case 'session':
        await engine.setSession(
          Map<String, String>.from(a['cookies'] as Map),
          a['username'] as String?,
        );
        return null;
      case 'signOut':
        await engine.signOut();
        return null;
      case 'addByLink':
        return engine.addByLink(a['link'] as String);
      case 'addWorks':
        return engine.addWorks(
          a['label'] as String,
          List<String>.from(a['ids'] as List),
        );
      case 'syncBookmarks':
        return engine.syncBookmarks();
      case 'syncPerson':
        return engine.syncPerson(
          a['byline'] as String,
          bookmarks: a['bookmarks'] as bool,
          andFetch: a['andFetch'] as bool,
          onProgress: (page, pages, found) => send({
            'type': 'progress',
            'id': id,
            'page': page,
            'pages': pages,
            'found': found,
          }),
        );
      case 'costOfAuthor':
        final cost = await engine.costOfAuthor(a['byline'] as String);
        return {
          'pages': cost.pages,
          'works': cost.works,
          'minutes': cost.minutes,
        };
      case 'addAuthor':
        return engine.addAuthor(a['byline'] as String);
      case 'kudos':
        return engine.leaveKudos(a['workId'] as String);
      case 'bookmark':
        await engine.bookmark(
          a['workId'] as String,
          notes: a['notes'] as String,
          tags: a['tags'] as String,
          private: a['private'] as bool,
          rec: a['rec'] as bool,
        );
        return null;
      case 'comment':
        await engine.comment(a['workId'] as String, a['text'] as String);
        return null;
      case 'picture':
        final bytes = await engine.fetchPicture(
          a['workId'] as String,
          a['src'] as String,
        );
        return bytes == null ? null : base64Encode(bytes);
      case 'pictures':
        return engine.fetchPicturesFor(a['workId'] as String);
      case 'pause':
        return engine.pause(a['job'] as int);
      case 'resume':
        return engine.resume(a['job'] as int);
      case 'stop':
        return engine.stop(a['job'] as int);
      case 'remove':
        return engine.remove(a['job'] as int);
      case 'rerun':
        return engine.rerun(a['job'] as int);
      case 'pauseAll':
        for (final j in engine.jobs.toList()) {
          engine.pause(j.id);
        }
        return null;
      default:
        throw ArgumentError('Unknown download command');
    }
  }

  /// Stop accepting commands, checkpoint, then close the client. Interrupted
  /// work remains recoverable; no UI disposal ever invokes this method.
  Future<void> close({bool timeout = false}) async {
    _closed = true;
    _idle?.cancel();
    if (timeout) {
      for (final j in engine.jobs.toList()) {
        engine.pause(j.id);
      }
    }
    engine.removeListener(_changed);
    try {
      await engine.flush();
      send({'type': 'state', ...downloadState(engine)});
    } finally {
      engine.dispose();
    }
  }
}
