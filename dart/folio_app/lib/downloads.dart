import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
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
abstract class Downloads extends ChangeNotifier {
  Downloads.base();
  factory Downloads({
    required Library library,
    Session session,
    core.ArchiveClient Function(core.Pacer)? clientFactory,
    core.Pacer Function(Future<void> Function())? pacerFactory,
  }) = LocalDownloads;

  Library get library;
  List<core.JobView> get jobs;
  Session get session;
  String? get signedInAs;
  String? get storageProblem;
  DateTime? get cooling;
  bool get busy;
  bool get canAct;
  Future<void> restore();
  void start();
  Future<void> flush();
  Future<void> useThisDevicesAgent();
  Future<void> refreshCookies();
  Future<int> addByLink(String link);
  Future<int> addWorks(String label, List<String> workIds);
  Future<int> syncBookmarks();
  Future<int> syncPerson(
    String byline, {
    required bool bookmarks,
    bool andFetch = true,
    void Function(int page, int? pages, int found)? onProgress,
  });
  Future<core.ListingCost> costOfAuthor(String byline);
  Future<int> addAuthor(String byline);
  Future<bool> leaveKudos(String workId);
  Future<void> bookmark(
    String workId, {
    String notes = '',
    String tags = '',
    bool private = false,
    bool rec = false,
  });
  Future<void> comment(String workId, String text);
  Future<Uint8List?> fetchPicture(String workId, String src);
  Future<int> fetchPicturesFor(String workId);
  bool pause(int id);
  bool resume(int id);
  bool stop(int id);
  bool remove(int id);
  bool rerun(int id);
  Future<void> adoptSession(Map<String, String> cookies, String who);
  Future<void> signOut();
}

class LocalDownloads extends Downloads {
  LocalDownloads({
    required this.library,
    Session session = Session.none,
    core.ArchiveClient Function(core.Pacer pacer)? clientFactory,
    core.Pacer Function(Future<void> Function() checkpoint)? pacerFactory,
  }) : _session = session,
       super.base() {
    _pacer = pacerFactory?.call(_persist) ?? core.Pacer(checkpoint: _persist);
    _client =
        clientFactory?.call(_pacer) ??
        core.ArchiveClient(pacer: _pacer, cookies: session.cookies);
    if (session.userAgent != null) _client.useAgent(session.userAgent!);
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
      // Keep failures visible for an explicit retry; don't repeat an entire
      // failed pass and mix its counters with the original request.
      maxRounds: 1,
      onEvent: (_, __, jobs) {
        _jobs = jobs;
        if (!_restoring) unawaited(_persist().catchError((Object _) {}));
        if (!_disposed) notifyListeners();
      },
    );
  }

  static const _stateKey = 'flutter.downloads.v1';
  Future<void> _writes = Future<void>.value();
  Object? _persistenceError;
  bool _restoring = false;
  bool _disposed = false;

  /// Read the queue before starting anything. Authentication and the Android
  /// service are attached by the shell before start() is called.
  @override
  Future<void> restore() async {
    final rows = await library.db.rawQuery(
      'SELECT value FROM meta WHERE key = ?',
      [_stateKey],
    );
    if (rows.isEmpty) return;
    final data =
        jsonDecode(rows.single['value']! as String) as Map<String, dynamic>;
    _restoring = true;
    try {
      _pacer.restore(Map<String, Object?>.from(data['pacer'] as Map));
      for (final job in data['jobs'] as List) {
        _queue.restore(
          core.SavedJob.fromJson(Map<String, Object?>.from(job as Map)),
          start: false,
        );
      }
    } finally {
      _restoring = false;
    }
  }

  @override
  void start() {
    _queue.startRestored();
    notifyListeners();
  }

  /// Snapshots are immutable and writes stay in event order. A request waits
  /// for its snapshot, so a failed disk write cannot silently lose the queue.
  Future<void> _persist() {
    if (_restoring || _disposed) return Future<void>.value();
    final value = jsonEncode({
      'pacer': _pacer.save(),
      'jobs': [for (final job in _queue.save()) job.toJson()],
    });
    final next = _writes.then((_) async {
      await library.db.rawInsert(
        'INSERT INTO meta (key, value) VALUES (?, ?) '
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [_stateKey, value],
      );
      _persistenceError = null;
    });
    _writes = next.catchError((Object error) {
      _persistenceError = error;
    });
    return next;
  }

  @override
  Future<void> flush() async {
    await _writes;
    if (_persistenceError != null) {
      throw StateError('Downloads could not be saved. Check device storage.');
    }
  }

  @override
  String? get storageProblem => _persistenceError == null
      ? null
      : 'Downloads could not be saved. Check device storage before continuing.';

  /// Fetch a work, and then the pictures in it.
  ///
  /// In that order and in the same turn: a chapter is worth having before its
  /// illustrations, and a work whose images are still coming should already
  /// be readable. Every one of them goes through the same clock as
  /// everything else — a work with forty inline pictures is forty requests,
  /// and they are somebody else's bandwidth as much as the archive's.
  Future<void> _fetch(String workId) async {
    await flush();
    if (_disposed) return;
    await _downloader.run(workId);
    try {
      final chapters = await library.db.rawQuery(
        'SELECT html FROM chapters WHERE work_id = ?',
        [workId],
      );
      final work = await library.db.rawQuery(
        'SELECT skin_css FROM works WHERE work_id = ?',
        [workId],
      );
      final html = [for (final row in chapters) '${row['html'] ?? ''}'];
      final skin = work.isEmpty ? null : work.first['skin_css'] as String?;
      await _pictures.fetchFor(workId, html, skinCss: skin);
    } catch (_) {
      /* A picture that will not come is not a work that failed. The text is
         already written down by here, and a chapter with a broken image in
         it is worth more than no chapter. */
    }
  }

  @override
  final Library library;
  late final core.Pacer _pacer;
  late final core.ArchiveClient _client;
  late final core.Downloader _downloader;
  late final core.Pictures _pictures;
  late final core.JobQueue _queue;

  List<core.JobView> _jobs = const [];
  @override
  List<core.JobView> get jobs => _jobs;

  Session _session;
  @override
  Session get session => _session;
  @override
  String? get signedInAs => _session.username;

  /// Present as the browser this device actually has.
  ///
  /// 1.x asked Android for it and sent that. Asked once, because it does not
  /// change while the app is running, and quietly: a device that will not say
  /// leaves the fallback in place rather than failing to download anything.
  Future<void> setAgent(String agent) async {
    _client.useAgent(agent);
    _session = Session(
      cookies: _session.cookies,
      username: _session.username,
      userAgent: agent,
    );
    await _session.save();
  }

  Future<void> setSession(Map<String, String> cookies, String? who) async {
    _client.setCookies(cookies);
    _session = Session(
      cookies: cookies,
      username: who,
      userAgent: _session.userAgent,
    );
    await _session.save();
    notifyListeners();
  }

  @override
  Future<void> useThisDevicesAgent() async {
    try {
      final agent = await InAppWebViewController.getDefaultUserAgent();
      if (agent.isNotEmpty) await setAgent(agent);
    } catch (_) {
      // not worth a single failed request, let alone a failed startup
    }
  }

  /// Take the cookies the webview holds now, rather than the ones copied down
  /// at sign-in.
  ///
  /// The archive reissues them — a session is refreshed, Cloudflare grants
  /// clearance again — and a snapshot taken once goes stale while the
  /// browser on the same device is holding the current set.
  @override
  Future<void> refreshCookies() async {
    try {
      final jar = await CookieManager.instance().getCookies(
        url: WebUri(core.origin),
      );
      if (jar.isEmpty) return;
      final held = {for (final c in jar) c.name: '${c.value}'};
      _client.setCookies(held);
      _session = Session(
        cookies: held,
        username: _session.username,
        userAgent: _session.userAgent,
      );
      await _session.save();
    } catch (_) {
      // the session already in hand is better than none
    }
  }

  /// Whether the archive has asked to be left alone, and until when.
  @override
  DateTime? get cooling => _pacer.coolingUntil;

  @override
  bool get busy => _jobs.any(
    (job) =>
        job.state == core.JobState.running ||
        job.state == core.JobState.pausing ||
        job.state == core.JobState.queued ||
        job.state == core.JobState.listing,
  );

  /// Add a work by link.
  ///
  /// Asking for a work by name plainly outranks a refusal made last month, so
  /// this drops the tombstone first. Nothing automatic does.
  @override
  Future<int> addByLink(String link) async {
    final target = core.linkTarget(link);
    final workId = target.workId;
    if (workId == null) {
      throw const FormatException(
        'That is not a link to a work on the archive.',
      );
    }
    await LibraryStore(library.db).allow(workId);
    final id = _queue.add(
      author: 'Added by link',
      part: workId,
      workIds: [workId],
    );
    await flush();
    return id;
  }

  /// Walk your bookmarks, queue what is not here, and reconcile the rest.
  ///
  /// Two things, not one. What to download is the works whose text is
  /// missing; what is bookmarked is every work the pages listed, whether or
  /// not it needed fetching. 1.x answered both with the second question and
  /// so never recorded a bookmark on a work it already held — and stopped
  /// walking at the first page of familiar works, leaving genuinely new
  /// bookmarks further down unseen.
  @override
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
          if (!await _queue.waitUntilRunnable(job)) {
            throw StateError('Listing stopped');
          }
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
      /* Stopped rather than sealed. A walk that threw did not finish, and a
         job that says Finished over an error message is the app telling two
         different stories in the same card. */
      _queue
        ..note(job, say: _went(e))
        ..stop(job);
    }
  }

  /// What went wrong, said the way the reader needs to hear it.
  ///
  /// An ArchiveError already carries a sentence somebody can act on; anything
  /// else is a Dart exception whose toString begins "Exception: ", which is
  /// noise in front of the part that matters.
  String _went(Object e) => e is core.ArchiveError
      ? e.message
      : '$e'.replaceFirst(RegExp(r'^Exception:\s*'), '');

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
  Future<core.Listing> _peek(
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
  @override
  Future<int> addWorks(String label, List<String> workIds) async {
    await _remember();
    final id = _queue.add(author: label, part: 'picked', workIds: workIds);
    await flush();
    return id;
  }

  /// Walk one person's pages and write down what they describe.
  ///
  /// One request describes twenty works, so this is how a catalogue becomes
  /// browsable for the price of reading an index — rather than downloading
  /// sixty works to find out what they are. Nothing is fetched here; what
  /// arrives is a shelf of descriptions, and any one of them can be asked for.
  @override
  Future<int> syncPerson(
    String byline, {
    required bool bookmarks,
    bool andFetch = true,
    void Function(int page, int? pages, int found)? onProgress,
  }) async {
    final store = LibraryStore(library.db);
    final seen = <String>[];
    var added = 0;

    await core.walkListing(
      fetchPage: (page) async {
        final listing = await _peek(byline, bookmarks: bookmarks, page: page);
        final ids = [for (final blurb in listing.works) blurb.workId];
        seen.addAll(ids);
        added += await saveStubs(
          library.db,
          listing.works,
          refused: await store.refused(ids),
        );
        onProgress?.call(page, listing.total, seen.length);
        return core.ListingPage(workIds: ids, totalPages: listing.total);
      },
    );

    if (bookmarks) await library.noteBookmarkedBy(byline, seen);
    await library.noteWalk('${bookmarks ? 'bookmarks' : 'works'}:$byline');
    if (andFetch) await _queueWhatIsStale(byline, seen);
    // how many the library did not already know about, which is the number
    // worth saying: "62 listed" on a second walk says nothing happened
    return added;
  }

  /// Queue what is actually worth a request.
  ///
  /// The planner decides, and it is the difference between a sync and a
  /// re-download. A work already held whose copy was taken after the archive
  /// last changed it costs nothing; one the archive has revised since is
  /// worth asking for again; one that is only a description has never been
  /// had at all. Most of a listing resolves to "do nothing", and doing
  /// nothing is what makes syncing sixty works take a minute rather than half
  /// an hour.
  ///
  /// What a refetch replaces is kept: the chapters it overwrites are archived
  /// first, so an author who rewrites a scene does not take the old one with
  /// them.
  Future<void> _queueWhatIsStale(String label, List<String> workIds) async {
    if (workIds.isEmpty) return;
    final marks = List.filled(workIds.length, '?').join(',');
    final rows = await library.db.rawQuery(
      'SELECT work_id, downloaded_at, updated, published, has_text, '
      'updated_at, skin_css FROM works WHERE work_id IN ($marks)',
      workIds,
    );

    final held = <String, core.HeldWork>{};
    final listed = <String, num?>{};
    for (final row in rows) {
      final id = '${row['work_id']}';
      listed[id] = row['updated_at'] as int?;
      if ((row['has_text'] as int? ?? 0) == 1) {
        held[id] = core.HeldWork(
          downloadedAt: row['downloaded_at'] as String?,
          updated: row['updated'] as String?,
          published: row['published'] as String?,
        );
      }
    }
    for (final id in workIds) {
      listed.putIfAbsent(id, () => null);
    }

    final plan = core.planSync(listed, held, wantSkins: false);
    final wanted = [
      ...plan[core.PlanAction.fetch],
      ...plan[core.PlanAction.refetch],
    ];
    final gone = await LibraryStore(library.db).refused(wanted);
    final queue = [
      for (final id in wanted)
        if (!gone.contains(id)) id,
    ];
    if (queue.isNotEmpty) await addWorks(label, queue);
  }

  /// How much of an author's catalogue there is, before any of it is fetched.
  ///
  /// One listing page describes twenty works for one request, so walking a
  /// prolific author is cheap per work and expensive in total. Knowing the
  /// size first is what lets a small author start instantly and a large one
  /// ask permission rather than quietly committing an hour of somebody's
  /// evening and the archive's patience.
  @override
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
  @override
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
          if (!await _queue.waitUntilRunnable(job)) {
            throw StateError('Listing stopped');
          }
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
        ..note(job, say: _went(e))
        ..stop(job);
    }
  }

  /// The things that leave the phone.
  ///
  /// Kudos are permanent, a comment notifies the author, a bookmark appears
  /// on a profile. None of them can be taken back from here, so each is its
  /// own deliberate act rather than a side effect of reading.
  core.Acts get _acts => core.Acts(_client);

  @override
  bool get canAct => _session.username != null;

  /// Leave kudos, and remember that they were left.
  ///
  /// The archive accepts them once per work per person and there is no way to
  /// ask afterwards whether they were, so the answer is kept here.
  @override
  Future<bool> leaveKudos(String workId) async {
    final done = await _acts.kudos(workId);
    await _mark(workId, 'kudos_given');
    return done.already;
  }

  @override
  Future<void> bookmark(
    String workId, {
    String notes = '',
    String tags = '',
    bool private = false,
    bool rec = false,
  }) async {
    await _acts.bookmark(
      workId,
      notes: notes,
      tags: tags,
      private: private,
      rec: rec,
    );
    await _mark(workId, 'in_bookmarks');
    if (rec) await _mark(workId, 'rec');
  }

  @override
  Future<void> comment(String workId, String text) =>
      _acts.comment(workId, text);

  Future<void> _mark(String workId, String column) async {
    await library.db.rawUpdate(
      'UPDATE works SET $column = 1 WHERE work_id = ?',
      [workId],
    );
    notifyListeners();
  }

  /// One picture, asked for from the page it is on.
  ///
  /// Fetched through the same clock as everything else and written down where
  /// it belongs, so a picture somebody asked for once is theirs — offline,
  /// next time, and in a backup. Null when it could not be had, which the
  /// reader is told rather than left to infer from a gap.
  @override
  Future<Uint8List?> fetchPicture(String workId, String src) async {
    final got = await _pictures.fetch(src);
    await LibraryPictures(library.db).put(workId, got);
    return got.bytes;
  }

  /// Everything this work points at that is not here yet.
  ///
  /// 1.x fetched a work's pictures too, and they travel in a backup like
  /// everything else — so for most imported works this finds nothing, which
  /// is the right answer. What it is for is the gaps: a work whose images
  /// were never got, one that has been revised since, and an author's skin,
  /// whose own assets 1.x never collected because it looked only for img
  /// tags and a stylesheet says url(...).
  @override
  Future<int> fetchPicturesFor(String workId) async {
    final chapters = await library.db.rawQuery(
      'SELECT html FROM chapters WHERE work_id = ?',
      [workId],
    );
    final work = await library.db.rawQuery(
      'SELECT skin_css FROM works WHERE work_id = ?',
      [workId],
    );
    final html = [for (final row in chapters) '${row['html'] ?? ''}'];
    final skin = work.isEmpty ? null : work.first['skin_css'] as String?;
    return _pictures.fetchFor(workId, html, skinCss: skin);
  }

  @override
  bool pause(int id) => _queue.pause(id);
  @override
  bool resume(int id) => _queue.resume(id);
  @override
  bool stop(int id) => _queue.stop(id);
  @override
  bool remove(int id) => _queue.remove(id);
  @override
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
  @override
  Future<void> adoptSession(Map<String, String> cookies, String who) async {
    await useThisDevicesAgent();
    _client.setCookies(cookies);
    _session = Session(
      cookies: cookies,
      username: who,
      userAgent: _session.userAgent,
    );
    await _session.save();
    notifyListeners();
  }

  /// Sign out here, which is not signing out there.
  @override
  Future<void> signOut() async {
    _client.forget();
    _session = Session.none;
    await Session.forget();
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final job in _jobs.toList()) {
      _queue.stop(job.id);
    }
    _client.close();
    super.dispose();
  }
}
