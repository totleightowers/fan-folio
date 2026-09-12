import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'library.dart';
import 'session.dart';
import 'store.dart';

/// The one place the archive is asked for anything.
///
/// The pacer, the client, the downloader and the queue, held together and
/// held once. There is deliberately no second path: 1.x had four loops that
/// each waited their own half minute, so three things running together made a
/// request every seven seconds while every one of them believed it was making
/// one every twenty-eight.
class Downloads extends ChangeNotifier {
  Downloads({required this.library, Session session = Session.none})
    : _pacer = core.Pacer(),
      _session = session {
    _client = core.ArchiveClient(pacer: _pacer, cookies: session.cookies);
    _downloader = core.Downloader(
      client: _client,
      store: LibraryStore(library.db),
    );
    _queue = core.JobQueue(
      runTask: _downloader.run,
      wait: (d) => Future<void>.delayed(d),
      shouldRetry: core.isTransient,
      retryWait: core.retryDelay,
      verify: _downloader.missing,
      onEvent: (_, __, jobs) {
        _jobs = jobs;
        notifyListeners();
      },
    );
  }

  final Library library;
  final core.Pacer _pacer;
  late final core.ArchiveClient _client;
  late final core.Downloader _downloader;
  late final core.JobQueue _queue;

  List<core.JobView> _jobs = const [];
  List<core.JobView> get jobs => _jobs;

  Session _session;
  Session get session => _session;
  String? get signedInAs => _session.username;

  /// Whether the archive has asked to be left alone, and until when.
  DateTime? get cooling => _pacer.coolingUntil;

  bool get busy => _jobs.any(
    (job) =>
        job.state == core.JobState.running ||
        job.state == core.JobState.queued ||
        job.state == core.JobState.listing,
  );

  /// Add a work by link.
  ///
  /// Asking for a work by name plainly outranks a refusal made last month, so
  /// this drops the tombstone first. Nothing automatic does.
  Future<int> addByLink(String link) async {
    final target = core.linkTarget(link);
    final workId = target.workId;
    if (workId == null) {
      throw const FormatException(
        'That is not a link to a work on the archive.',
      );
    }
    await LibraryStore(library.db).allow(workId);
    return _queue.add(author: 'Added by link', part: workId, workIds: [workId]);
  }

  bool pause(int id) => _queue.pause(id);
  bool resume(int id) => _queue.resume(id);
  bool stop(int id) => _queue.stop(id);
  bool remove(int id) => _queue.remove(id);
  bool rerun(int id) => _queue.rerun(id);

  /// Sign in, and keep the session that comes back.
  ///
  /// The password is handed to the archive's own form and goes no further:
  /// what is kept is the cookie, in app-private storage beside the library
  /// rather than inside it, so it does not travel in a backup.
  Future<String> signIn(String username, String password) async {
    final who = await _client.signIn(username, password);
    _session = Session(cookies: _client.cookies, username: who);
    await _session.save();
    notifyListeners();
    return who;
  }

  /// Sign out here, which is not signing out there.
  Future<void> signOut() async {
    _client.forget();
    _session = Session.none;
    await Session.forget();
    notifyListeners();
  }

  @override
  void dispose() {
    _client.close();
    super.dispose();
  }
}
