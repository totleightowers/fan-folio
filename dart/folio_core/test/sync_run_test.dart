import 'dart:convert';
import 'dart:io';

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// The walks, and what the app decides about a failure.
///
/// `tools/emit-sync-conformance.mjs` runs a body of failure reasons through
/// the 1.x implementation and records what it said. The order of those rules
/// is the whole answer — a 429 has to be read as "slow down" before the
/// blanket 4xx rule reads it as "no" — and getting it wrong writes off every
/// work in flight the moment the archive starts throttling.
void main() {
  final fixture =
      jsonDecode(File('test/conformance/sync.json').readAsStringSync())
          as Map<String, Object?>;

  group('worth trying again, or not', () {
    for (final entry
        in (fixture['failures'] as List).cast<Map<String, Object?>>()) {
      final reason = entry['reason'] as String?;
      test('"${reason ?? '(nothing said)'}"', () {
        expect(
          isTransient(reason),
          entry['transient'],
          reason: 'the two versions disagree about whether to retry this',
        );
      });
    }
  });

  test('and waits longer each time, up to a point', () {
    for (final entry
        in (fixture['retries'] as List).cast<Map<String, Object?>>()) {
      expect(
        retryDelay(entry['attempt']! as int).inMilliseconds,
        entry['ms'],
      );
    }
  });

  test('a listing costs what 1.x says it costs', () {
    expect(perListingPage, fixture['perListingPage']);
    for (final entry
        in (fixture['listings'] as List).cast<Map<String, Object?>>()) {
      final pages = entry['pages'] as int?;
      final cost = entry['cost']! as Map<String, Object?>;
      final actual = listingCost(pages);
      expect(actual.pages, cost['pages'], reason: 'pages for $pages');
      expect(actual.works, cost['works'], reason: 'works for $pages');
      expect(actual.minutes, cost['minutes'], reason: 'minutes for $pages');
      expect(shouldWalkWholeListing(pages), entry['whole']);
    }
  });

  group('walking the bookmarks', () {
    ListingPage page(List<String> ids, {int? total}) =>
        ListingPage(workIds: ids, totalPages: total);

    test('stops where the bookmarks stop being new', () async {
      /* Bookmarks are listed newest first, so a page where every one was
         already known means the rest was too. A full re-walk is 86 pages. */
      final asked = <int>[];
      final result = await findNewBookmarks(
        fetchPage: (p) async {
          asked.add(p);
          return page(p == 1 ? ['new1', 'old1'] : ['old2', 'old3'], total: 86);
        },
        isHeld: (id) => id.startsWith('old'),
        isBookmarked: (id) => id.startsWith('old'),
      );

      expect(asked, [1, 2], reason: 'page two was all familiar; stop there');
      expect(result.workIds, ['new1']);
      expect(result.seen, ['new1', 'old1', 'old2', 'old3']);
    });

    test('a work already held can still be a new bookmark', () async {
      /* The bug this is here for: "is this among my bookmarks" and "do I have
         its text" are different facts, and 1.x used the second for both. So a
         work you already had and bookmarked today recorded nothing, and a
         page of works held for other reasons ended the walk early. */
      var pages = 0;
      final result = await findNewBookmarks(
        fetchPage: (p) async {
          pages++;
          return page(p == 1 ? ['held'] : ['known'], total: 5);
        },
        isHeld: (_) => true,
        isBookmarked: (id) => id == 'known',
      );

      expect(pages, 2, reason: 'page one was a new bookmark, so keep going');
      expect(result.seen, ['held', 'known'],
          reason: 'bookmark state is written from everything walked');
      expect(result.workIds, isEmpty, reason: 'nothing needs downloading');
    });

    test('and stops when asked to', () async {
      var pages = 0;
      var stop = false;
      final result = await findNewBookmarks(
        fetchPage: (p) async {
          pages++;
          stop = true;
          return page(['a$p'], total: 40);
        },
        isHeld: (_) => false,
        shouldStop: () => stop,
      );
      expect(pages, 1);
      expect(result.workIds, ['a1']);
    });
  });

  group('walking a listing', () {
    test('sees all of it, familiar works included', () async {
      /* Unlike the bookmark sync, an author page is asked for in order to see
         all of it, so a work already held still belongs in the list. */
      final walk = await walkListing(
        fetchPage: (p) async => ListingPage(
          workIds: ['w${p}a', 'w${p}b'],
          totalPages: 3,
        ),
      );
      expect(walk.totalPages, 3);
      expect(walk.workIds, ['w1a', 'w1b', 'w2a', 'w2b', 'w3a', 'w3b']);
    });

    test('an empty page is the end of it', () async {
      final walk = await walkListing(
        fetchPage: (p) async =>
            ListingPage(workIds: p == 1 ? ['only'] : const []),
      );
      expect(walk.workIds, ['only']);
    });
  });

  group('fetching a list of works', () {
    test('one that cannot be had is stepped over, not fatal', () async {
      /* A bookmark outlives the work it points at, and one deleted story
         should not end a sync. */
      final result = await fetchWorks<String>(
        workIds: ['a', 'gone', 'b'],
        fetchWork: (id) async {
          if (id == 'gone') throw Exception('that work does not exist');
          return id.toUpperCase();
        },
      );
      expect(result.added, ['A', 'B']);
      expect(result.failed.single.workId, 'gone');
      expect(result.failed.single.transient, isFalse,
          reason: 'a work that is gone will be gone next time too');
    });

    test('and one that was throttled is worth queueing again', () async {
      final result = await fetchWorks<String>(
        workIds: ['a'],
        fetchWork: (_) async => throw Exception('the archive answered 429'),
      );
      expect(result.failed.single.transient, isTrue);
    });

    test('progress is reported per work, not per batch', () async {
      final seen = <int>[];
      await fetchWorks<String>(
        workIds: ['a', 'b', 'c'],
        fetchWork: (id) async => id,
        onProgress: (p) => seen.add(p.done!),
      );
      expect(seen, [1, 2, 3]);
    });
  });
}
