/// Keeping the library current, from inside the app.
///
/// The walks and the retry rules, ported from `app/core/sync/run.js`. The
/// pacing lives next door in `pacer.dart`, because everything the archive is
/// asked for goes through one clock — that matters more than anything else
/// here. An app that walks somebody's bookmarks impatiently gets their account
/// limited, and they will not know why.
library;

import 'pacer.dart' show minGap;

/// Twenty to a listing page, which is what decides how many pages a walk is.
const int perListingPage = 20;

/// One page of a listing: what it described, and where it sits.
class ListingPage {
  const ListingPage({required this.workIds, this.totalPages});

  final List<String> workIds;
  final int? totalPages;
}

/// How far along a walk or a download is.
class SyncProgress {
  const SyncProgress({
    required this.phase,
    this.page,
    this.totalPages,
    this.done,
    this.total,
    this.found,
  });

  final String phase;
  final int? page;
  final int? totalPages;
  final int? done;
  final int? total;
  final int? found;
}

/// What a walk of the bookmark pages turned up.
class NewBookmarks {
  const NewBookmarks({
    required this.workIds,
    required this.seen,
    required this.pagesWalked,
  });

  /// The ones whose text is not held. What there is to download.
  final List<String> workIds;

  /// Every work on the pages walked, held or not. Bookmark state is written
  /// from this, which is a different fact from whether the text is here.
  final List<String> seen;

  final int pagesWalked;
}

/// Walk the bookmark pages until they stop telling us anything new.
///
/// Bookmarks are listed newest first, so once a whole page is already known
/// there is nothing older worth walking to — the rest of the list was
/// collected on a previous run. A full re-walk is 86 pages; this is usually
/// one.
///
/// Two questions live here and 1.x answered them as one. "Is this among my
/// bookmarks" and "do I have this work's text" are different facts, and the
/// walk used the second for both — so a work already in the library that you
/// bookmarked today was not recognised as a new bookmark at all, and a page of
/// works held for other reasons stopped the walk with genuinely new bookmarks
/// further down unseen.
Future<NewBookmarks> findNewBookmarks({
  required Future<ListingPage> Function(int page) fetchPage,
  required bool Function(String workId) isHeld,
  bool Function(String workId) isBookmarked = _no,
  int maxPages = 40,
  void Function(SyncProgress) onProgress = _ignore,
  bool Function() shouldStop = _never,
}) async {
  final seen = <String>[];
  final needed = <String>[];
  int? totalPages;

  for (var page = 1; page <= maxPages; page++) {
    if (shouldStop()) break;
    final listing = await fetchPage(page);
    totalPages = listing.totalPages ?? totalPages;

    for (final workId in listing.workIds) {
      seen.add(workId);
      if (!isHeld(workId)) needed.add(workId);
    }
    final newlyBookmarked = listing.workIds.where((id) => !isBookmarked(id));
    onProgress(
      SyncProgress(
        phase: 'listing',
        page: page,
        totalPages: totalPages,
        found: needed.length,
      ),
    );

    // a page where every bookmark was already known means the rest was too
    if (newlyBookmarked.isEmpty) break;
    if (totalPages != null && page >= totalPages) break;
  }

  return NewBookmarks(
    workIds: needed,
    seen: seen,
    pagesWalked: totalPages == null
        ? maxPages
        : (maxPages < totalPages ? maxPages : totalPages),
  );
}

/// A work that could not be had, and why.
class FetchFailure {
  const FetchFailure(this.workId, this.reason);
  final String workId;
  final String reason;

  /// Whether it is worth queueing again.
  bool get transient => isTransient(reason);
}

class FetchResult<T> {
  const FetchResult({required this.added, required this.failed});
  final List<T> added;
  final List<FetchFailure> failed;
}

/// Fetch a list of works, one at a time, waiting between each.
///
/// A work that cannot be fetched is recorded and stepped over: a bookmark
/// outlives the work it points at, and one deleted story should not end a
/// sync.
Future<FetchResult<T>> fetchWorks<T>({
  required List<String> workIds,
  required Future<T> Function(String workId) fetchWork,
  void Function(SyncProgress) onProgress = _ignore,
  bool Function() shouldStop = _never,
}) async {
  final added = <T>[];
  final failed = <FetchFailure>[];

  for (var i = 0; i < workIds.length; i++) {
    if (shouldStop()) break;
    final workId = workIds[i];
    try {
      added.add(await fetchWork(workId));
    } catch (e) {
      failed.add(FetchFailure(workId, '$e'));
    }
    onProgress(
      SyncProgress(
        phase: 'fetching',
        done: i + 1,
        total: workIds.length,
        found: added.length,
      ),
    );
  }

  return FetchResult(added: added, failed: failed);
}

/// How much work an author's listing represents, before any of it is done.
///
/// A listing page describes twenty works for one request, so walking a
/// prolific author is cheap per work and expensive in total. Knowing the size
/// first is what lets a small author open instantly and a large one ask
/// permission.
class ListingCost {
  const ListingCost({
    required this.pages,
    required this.works,
    required this.minutes,
  });

  final int pages;
  final int works;
  final int minutes;
}

ListingCost listingCost(int? totalPages, {int perPage = perListingPage}) {
  final asked = totalPages ?? 1;
  final pages = asked < 1 ? 1 : asked;
  return ListingCost(
    pages: pages,
    works: pages * perPage,
    minutes: (pages * minGap.inMilliseconds / 60000).ceil(),
  );
}

/// Whether to walk the rest without being asked.
///
/// Under the threshold the whole listing is a handful of requests and waiting
/// for a tap only adds a tap. Over it, the reader is committing minutes of
/// their time and the archive's patience, and should say so first.
bool shouldWalkWholeListing(int? totalPages, {int threshold = 200}) =>
    listingCost(totalPages).works < threshold;

class Walk {
  const Walk({required this.workIds, required this.totalPages});
  final List<String> workIds;
  final int totalPages;
}

/// Walk every page of a listing, collecting what it describes.
///
/// Unlike the bookmark sync this does not stop early at familiar works: an
/// author page is asked for in order to see all of it, and a work already held
/// still belongs in the list.
Future<Walk> walkListing({
  required Future<ListingPage> Function(int page) fetchPage,
  int maxPages = 200,
  void Function(SyncProgress) onProgress = _ignore,
  bool Function() shouldStop = _never,
}) async {
  final workIds = <String>[];
  int? totalPages;

  for (var page = 1; page <= maxPages; page++) {
    if (shouldStop()) break;
    final listing = await fetchPage(page);
    totalPages = listing.totalPages ?? totalPages;
    workIds.addAll(listing.workIds);
    onProgress(
      SyncProgress(
        phase: 'listing',
        page: page,
        totalPages: totalPages,
        found: workIds.length,
      ),
    );

    if (listing.workIds.isEmpty) break;
    if (totalPages != null && page >= totalPages) break;
  }

  return Walk(workIds: workIds, totalPages: totalPages ?? 1);
}

/// Is this worth trying again?
///
/// A work that was deleted will be deleted next time too, and asking again is
/// rude and pointless. A 500 is the archive having a bad moment; giving up on
/// it and calling the work "unavailable" writes off something that was
/// probably fine a minute later.
bool isTransient(String? reason) {
  final text = reason ?? '';

  /* Being told to slow down is not being told no. 429 is the archive
     rate-limiting, which is the most retriable thing there is — and in 1.x it
     landed in the blanket 4xx rule below and was written off as a work that
     could not be had. During a long download that is the worst possible
     reading of it: the moment the archive starts throttling, every work in
     flight is permanently skipped. 408 and 425 are the same kind of answer. */
  if (RegExp(r'answered (429|408|425)', caseSensitive: false).hasMatch(text)) {
    return true;
  }
  if (RegExp(
    r'rate limit|too many requests|retry.?after|slow down',
    caseSensitive: false,
  ).hasMatch(text)) {
    return true;
  }

  // it answered, and said no
  if (RegExp(r'answered 4\d\d', caseSensitive: false).hasMatch(text)) {
    return false;
  }
  if (RegExp(
    r'deleted|does not exist|no chapters found',
    caseSensitive: false,
  ).hasMatch(text)) {
    return false;
  }

  /* Never getting there is always worth trying again. These are the ways a
     phone fails to reach a host, and every one of them is a moment rather
     than a verdict: a tunnel, a handover between masts, a network that has
     not finished coming up. Named rather than matched loosely, because
     "unavailable" has to keep meaning something — a work that is genuinely
     gone still stops above. */
  for (final pattern in const [
    r'answered 5\d\d|could not reach|timed out|timeout|network|failed to fetch',
    r'unable to resolve host|no address associated|unknownhost|enotfound'
        r'|eai_again',
    r'connection (reset|refused|abort|closed)|econnreset|econnrefused'
        r'|econnaborted',
    r'unexpected end of stream|broken pipe'
        r'|software caused connection abort',
    r'sslexception|handshake|socketexception|sockettimeout|protocol error',
  ]) {
    if (RegExp(pattern, caseSensitive: false).hasMatch(text)) return true;
  }
  return false;
}

/// How long to leave it before trying again: longer each time.
Duration retryDelay(int attempt, {Duration? base}) {
  final from = base ?? minGap;
  final factor = attempt >= 3 ? 8 : (1 << attempt);
  return Duration(milliseconds: from.inMilliseconds * factor);
}

bool _no(String _) => false;
bool _never() => false;
void _ignore(SyncProgress _) {}
