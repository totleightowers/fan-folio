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

  /// Walk your bookmarks, queue what is not here, and reconcile the rest.
  ///
  /// Two things, not one. What to download is the works whose text is
  /// missing; what is bookmarked is every work the pages listed, whether or
  /// not it needed fetching. 1.x answered both with the second question and
  /// so never recorded a bookmark on a work it already held — and stopped
  /// walking at the first page of familiar works, leaving genuinely new
  /// bookmarks further down unseen.
  Future<int> syncBookmarks() async {
    final who = _session.username;
    if (who == null) {
      throw const core.ArchiveError(
        'Sign in first — your bookmarks are only visible to you.',
      );
    }

    await _remember();
    final job = _queue.add(author: 'My bookmarks', part: 'sync', open: true);
    unawaited(_walkBookmarks(job, who));
    return job;
  }

  Future<void> _walkBookmarks(int job, String who) async {
    final store = LibraryStore(library.db);
    try {
      final found = await core.findNewBookmarks(
        fetchPage: (page) async {
          final listing = core.parseListing(
            (await _client.get(Uri.parse(core.bookmarks(who, page)))).body,
          );
          return core.ListingPage(
            workIds: [for (final blurb in listing.works) blurb.workId],
            totalPages: listing.total,
          );
        },
        isHeld: (workId) => _held.contains(workId),
        isBookmarked: (workId) => _bookmarked.contains(workId),
        onProgress: (p) => _queue.note(job, page: p.page, pages: p.totalPages),
        shouldStop: () => _queue.isStopped(job),
      );

      /* Whose bookmarks these are now, as one answer. A work that has stopped
         being bookmarked does not appear anywhere, so removal cannot be seen
         a page at a time. Only membership changes: you unbookmarked it, you
         did not ask to lose it. */
      final counts = await library.reconcileBookmarks(found.seen);
      await library.noteBookmarkSync(DateTime.now());

      // and what is actually missing, asked of the library rather than
      // assumed from what the listing said
      final wanted = await store.held(found.workIds);
      final missing = [
        for (final workId in found.workIds)
          if (!wanted.contains(workId)) workId,
      ];

      _queue
        ..note(
          job,
          say:
              '${counts.kept} bookmarked'
              '${counts.dropped > 0 ? ', ${counts.dropped} no longer' : ''}'
              '${missing.isEmpty ? '' : ', ${missing.length} to fetch'}',
        )
        ..append(job, missing)
        ..seal(job);
    } catch (e) {
      _queue
        ..note(job, say: '$e')
        ..seal(job);
    }
  }

  /// What the library already holds, read once rather than per page.
  Set<String> _held = const {};
  Set<String> _bookmarked = const {};

  /// Read before a walk, because asking the database twenty times a page is
  /// twenty round trips for a question whose answer does not change mid-walk.
  Future<void> _remember() async {
    final rows = await library.db.rawQuery(
      'SELECT work_id, COALESCE(has_text, 0) AS t, '
      'COALESCE(in_bookmarks, 0) AS b FROM works',
    );
    _held = {
      for (final row in rows)
        if (row['t'] == 1) '${row['work_id']}',
    };
    _bookmarked = {
      for (final row in rows)
        if (row['b'] == 1) '${row['work_id']}',
    };
  }

  /// How much of an author's catalogue there is, before any of it is fetched.
  ///
  /// One listing page describes twenty works for one request, so walking a
  /// prolific author is cheap per work and expensive in total. Knowing the
  /// size first is what lets a small author start instantly and a large one
  /// ask permission rather than quietly committing an hour of somebody's
  /// evening and the archive's patience.
  Future<core.ListingCost> costOfAuthor(String byline) async {
    final page = await _client.get(Uri.parse(core.authorWorks(byline)));
    return core.listingCost(core.parseListing(page.body).total);
  }

  /// Everything one person wrote.
  ///
  /// Unlike the bookmark sync this does not stop early at familiar works: an
  /// author page is asked for in order to see all of it, and a work already
  /// held still belongs in the list. The first page is queued the moment it
  /// lands and the rest arrives as it is read — waiting for the whole walk
  /// first is a minute or two of an app that looks like it did nothing.
  Future<int> addAuthor(String byline) async {
    await _remember();
    final job = _queue.add(author: byline, part: 'works', open: true);
    unawaited(_walkAuthor(job, byline));
    return job;
  }

  Future<void> _walkAuthor(int job, String byline) async {
    final store = LibraryStore(library.db);
    try {
      var found = 0;
      await core.walkListing(
        fetchPage: (page) async {
          final listing = core.parseListing(
            (await _client.get(Uri.parse(core.authorWorks(byline, page)))).body,
          );
          final ids = [for (final blurb in listing.works) blurb.workId];
          found += ids.length;

          // what is not already here, so a re-walk of a mostly-held author
          // costs the listing pages and nothing else
          final have = await store.held(ids);
          final gone = await store.refused(ids);
          _queue.append(job, [
            for (final id in ids)
              if (!have.contains(id) && !gone.contains(id)) id,
          ]);
          return core.ListingPage(workIds: ids, totalPages: listing.total);
        },
        onProgress: (p) => _queue.note(job, page: p.page, pages: p.totalPages),
        shouldStop: () => _queue.isStopped(job),
      );

      _queue
        ..note(job, say: '$found listed')
        ..seal(job);
    } catch (e) {
      _queue
        ..note(job, say: '$e')
        ..seal(job);
    }
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
