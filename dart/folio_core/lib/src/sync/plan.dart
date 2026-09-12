/// Decide what actually needs fetching.
///
/// This is where the request budget is won or lost. Given what is already held
/// and what the listings say exists, most works resolve to "do nothing" — and
/// a work that resolves to "do nothing" costs zero requests instead of one.
///
/// Pure: no fetching, no database, no clock beyond what is passed in. Every
/// decision here is testable, which matters because a wrong "skip" silently
/// leaves a gap in the library and a wrong "fetch" costs an hour.
library;

/// The archive's listing epoch, as the YYYY-MM-DD an EPUB preface records.
String? epochToDate(num? epoch) {
  if (epoch == null || !epoch.isFinite) return null;
  final ms = epoch * 1000;
  /* A listing can carry a number that is not a date. Both languages say such
     a number is finite and then refuse to make a date of it, and in 1.x that
     threw — so one malformed row ended the whole plan rather than being
     ignored. The bound is the largest instant either can represent. */
  if (ms.abs() > 8640000000000000) return null;
  return DateTime.fromMillisecondsSinceEpoch(
    ms.round(),
    isUtc: true,
  ).toIso8601String().substring(0, 10);
}

/// What the library holds of one work, as far as deciding goes.
class HeldWork {
  const HeldWork({
    this.downloadedAt,
    this.updated,
    this.completed,
    this.published,
    this.needsSkin = false,
    this.skinCss,
  });

  factory HeldWork.fromMap(Map<String, Object?> row) => HeldWork(
        downloadedAt: row['downloadedAt'] as String?,
        updated: row['updated'] as String?,
        completed: row['completed'] as String?,
        published: row['published'] as String?,
        needsSkin: row['needsSkin'] == true,
        skinCss: row['skinCss'] as String?,
      );

  final String? downloadedAt;
  final String? updated;
  final String? completed;
  final String? published;
  final bool needsSkin;
  final String? skinCss;
}

/// The best "when was this last changed" a stored work can offer.
///
/// Only about a quarter of the library records an updated or completed date,
/// so the date the copy was taken is the primary signal — it answers "is our
/// copy current?" directly, where published answers only "when did this first
/// appear?" and flags every revised work as stale.
String? heldAsOf(HeldWork? held) =>
    held?.downloadedAt ?? held?.updated ?? held?.completed ?? held?.published;

enum PlanAction {
  /// Not held at all.
  fetch,

  /// Held, but the archive says it changed.
  refetch,

  /// Held and current, but the work skin was never stored.
  skin,

  /// Held, current, nothing wanted.
  skip,
}

class SyncPlan {
  const SyncPlan({required this.actions, required this.reasons});

  final Map<PlanAction, List<String>> actions;

  /// Why each work landed where it did, which is what makes a plan reviewable
  /// rather than a number to be trusted.
  final Map<String, String> reasons;

  List<String> operator [](PlanAction action) => actions[action] ?? const [];

  int get listed => reasons.length;

  /// What the plan costs. A skip is free; everything else is one request.
  int get requests =>
      this[PlanAction.fetch].length +
      this[PlanAction.refetch].length +
      this[PlanAction.skin].length;
}

SyncPlan planSync(
  Map<String, num?> listedUpdatedAt,
  Map<String, HeldWork> library, {
  bool wantSkins = true,
}) {
  final actions = {for (final action in PlanAction.values) action: <String>[]};
  final reasons = <String, String>{};

  void note(String workId, PlanAction action, String why) {
    actions[action]!.add(workId);
    reasons[workId] = why;
  }

  listedUpdatedAt.forEach((workId, updatedAt) {
    final have = library[workId];
    if (have == null) {
      note(workId, PlanAction.fetch, 'not held');
      return;
    }

    final listedDate = epochToDate(updatedAt);
    final ourDate = heldAsOf(have);
    /* No date on either side means no evidence of change — and guessing
       "changed" here would refetch the whole library for nothing. */
    if (listedDate != null &&
        ourDate != null &&
        listedDate.compareTo(ourDate) > 0) {
      note(workId, PlanAction.refetch, 'AO3 $listedDate > held $ourDate');
      return;
    }

    if (wantSkins && have.needsSkin && (have.skinCss ?? '').isEmpty) {
      note(workId, PlanAction.skin, 'custom markup with no skin stored');
      return;
    }

    note(workId, PlanAction.skip, 'held and current');
  });

  return SyncPlan(actions: actions, reasons: reasons);
}

/// Wall-clock estimate, so a plan can be judged before it runs.
class Estimate {
  const Estimate({
    required this.requests,
    required this.hours,
    required this.human,
  });

  final int requests;
  final double hours;
  final String human;
}

/// A shade above the minimum gap, because the gaps are drawn around a mean
/// and an estimate built on the floor of them always reads short.
const Duration estimateGap = Duration(milliseconds: 29000);

Estimate estimate(int requests, {Duration meanGap = estimateGap}) {
  final ms = requests * meanGap.inMilliseconds;
  final hours = ms / 3600000;
  return Estimate(
    requests: requests,
    hours: double.parse(hours.toStringAsFixed(1)),
    human: hours < 1
        ? '${(ms / 60000).round()} min'
        : '${hours.toStringAsFixed(1)} hours',
  );
}

/// Where a work was listed, which the reader can still filter by afterwards.
class Listed {
  const Listed({
    this.updatedAt,
    this.inBookmarks = false,
    this.inHistory = false,
  });

  final num? updatedAt;
  final bool inBookmarks;
  final bool inHistory;
}

/// Merge the two listings into one set of works to consider.
///
/// History and bookmarks overlap heavily — you bookmark what you read — and a
/// work in both must be fetched once, not twice. Membership is kept so the
/// reader can still ask for what they bookmarked as against what they read.
Map<String, Listed> mergeListings({
  Map<String, num?> bookmarks = const {},
  Map<String, num?> history = const {},
}) {
  final merged = <String, Listed>{};

  void add(Map<String, num?> works, {required bool bookmarked}) {
    works.forEach((workId, updatedAt) {
      final before = merged[workId];
      // the two pages can disagree by a hit; keep whichever epoch is newer
      final newest = [
        before?.updatedAt ?? 0,
        updatedAt ?? 0,
      ].reduce((a, b) => a > b ? a : b);
      merged[workId] = Listed(
        updatedAt: newest == 0 ? null : newest,
        inBookmarks: (before?.inBookmarks ?? false) || bookmarked,
        inHistory: (before?.inHistory ?? false) || !bookmarked,
      );
    });
  }

  add(bookmarks, bookmarked: true);
  add(history, bookmarked: false);
  return merged;
}
