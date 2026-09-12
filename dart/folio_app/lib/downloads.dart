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
    _pictures = core.Pictures(
      client: _client,
      store: LibraryPictures(library.db),
    );
    _queue = core.JobQueue(
      runTask: _fetch,
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

  /// Fetch a work, and then the pictures in it.
  ///
  /// In that order and in the same turn: a chapter is worth having before its
  /// illustrations, and a work whose images are still coming should already
  /// be readable. Every one of them goes through the same clock as
  /// everything else — a work with forty inline pictures is forty requests,
  /// and they are somebody else's bandwidth as much as the archive's.
  Future<void> _fetch(String workId) async {
    await _downloader.run(workId);
    try {
      final chapters = await library.db.rawQuery(
        'SELECT html FROM chapters WHERE work_id = ?',
        [workId],
      );
      await _pictures.fetchFor(workId, [
        for (final row in chapters) '${row['html'] ?? ''}',
      ]);
    } catch (_) {
      /* A picture that will not come is not a work that failed. The text is
         already written down by here, and a chapter with a broken image in
         it is worth more than no chapter. */
    }
  }

  final Library library;
  final core.Pacer _pacer;
  late final core.ArchiveClient _client;
  late final core.Downloader _downloader;
  late final core.Pictures _pictures;
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

  /// What one person's pages say they have, without fetching any of it.
  ///
  /// Their works, or their bookmarks. A listing page describes twenty works
  /// for one request, which is why this is worth having at all: it is the
  /// difference between knowing what somebody has written and downloading it.
  Future<core.Listing> peek(
    String byline, {
    bool bookmarks = false,
    int page = 1,
  }) async {
    final url = bookmarks
        ? core.authorBookmarks(byline, page)
        : core.authorWorks(byline, page);
    return core.parseListing((await _client.get(Uri.parse(url))).body);
  }

  /// Fetch a named handful, rather than a whole catalogue.
  ///
  /// Which is most of what somebody actually wants from a person's page:
  /// three of these, not all sixty.
  Future<int> addWorks(String label, List<String> workIds) async {
    await _remember();
    return _queue.add(author: label, part: 'picked', workIds: workIds);
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

  /// The things that leave the phone.
  ///
  /// Kudos are permanent, a comment notifies the author, a bookmark appears
  /// on a profile. None of them can be taken back from here, so each is its
  /// own deliberate act rather than a side effect of reading.
  core.Acts get acts => core.Acts(_client);

  bool get canAct => _session.username != null;

  /// Leave kudos, and remember that they were left.
  ///
  /// The archive accepts them once per work per person and there is no way to
  /// ask afterwards whether they were, so the answer is kept here.
  Future<bool> leaveKudos(String workId) async {
    final done = await acts.kudos(workId);
    await _mark(workId, 'kudos_given');
    return done.already;
  }

  Future<void> bookmark(
    String workId, {
    String notes = '',
    String tags = '',
    bool private = false,
    bool rec = false,
  }) async {
    await acts.bookmark(
      workId,
      notes: notes,
      tags: tags,
      private: private,
      rec: rec,
    );
    await _mark(workId, 'in_bookmarks');
    if (rec) await _mark(workId, 'rec');
  }

  Future<void> comment(String workId, String text) =>
      acts.comment(workId, text);

  Future<void> _mark(String workId, String column) async {
    await library.db.rawUpdate(
      'UPDATE works SET $column = 1 WHERE work_id = ?',
      [workId],
    );
    notifyListeners();
  }

  bool pause(int id) => _queue.pause(id);
  bool resume(int id) => _queue.resume(id);
  bool stop(int id) => _queue.stop(id);
  bool remove(int id) => _queue.remove(id);
  bool rerun(int id) => _queue.rerun(id);

  /// Take on the session somebody just signed in with.
  ///
  /// The cookies come from the webview the archive's own sign-in page was
  /// shown in, which is the only place they can come from: the archive has no
  /// endpoint for other people's apps to call, and a password typed into this
  /// one would be the wrong shape even where it worked.
  ///
  /// Kept beside the library rather than inside it, so it does not travel in
  /// a backup — a backup is made to be handed to a new phone, and a session
  /// cookie inside one is an account somebody else can sign into.
  Future<void> adoptSession(Map<String, String> cookies, String who) async {
    _client.setCookies(cookies);
    _session = Session(cookies: cookies, username: who);
    await _session.save();
    notifyListeners();
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
