/// Where the reader got to, written down.
///
/// Ported from the statements the 1.x shell runs. A reading position is the
/// difference between an app somebody keeps and one they abandon: losing your
/// place in a hundred thousand words is not a small bug.
///
/// The rules are the ones 1.x arrived at, and each of them was a fault once:
/// a chapter completes by being left, opening is not the same as positioning,
/// and finishing has to be an event rather than something inferred later.
library;

import '../store/migrate.dart' show SqlRunner;
import '../store/query.dart' show chapters;

/// This app opened the work, without saying where in it.
///
/// Kept apart from [saveProgress] deliberately. Opening a work from a search
/// result is a peek: it must not move the bookmark, because jumping to a
/// passage two chapters back and then leaving should not cost somebody the
/// place they had reached. But it is still reading, and it still belongs at
/// the front of Continue reading. Two facts, so two calls.
Future<void> markOpened(SqlRunner db, String workId) => db.execute(
      "INSERT INTO reading (work_id, opened_at) VALUES ('$workId', datetime('now')) "
      'ON CONFLICT(work_id) DO UPDATE SET opened_at = excluded.opened_at',
    );

/// Where in the work, and how far down the page.
///
/// chapters_read is `chapter - 1`, because a chapter counts as complete once
/// it has been left. That is right while a chapter is in progress and wrong at
/// the end of the last one, which is why finishing is its own event.
const String saveProgressSql =
    'INSERT INTO reading (work_id, chapter, offset, chapters_read, updated_at, opened_at) '
    "VALUES (?,?,?,?,datetime('now'),datetime('now')) "
    'ON CONFLICT(work_id) DO UPDATE SET '
    '  chapter = excluded.chapter, '
    '  offset = excluded.offset, '
    '  chapters_read = max(COALESCE(reading.chapters_read, 0), excluded.chapters_read), '
    '  updated_at = excluded.updated_at, '
    '  opened_at = excluded.opened_at';

/// Finished, said rather than inferred.
///
/// The total comes from the database, not from whatever the reader believed:
/// metadata first, the chapters actually held when there is none. Finished
/// therefore means exactly not-still-reading, which is the predicate the
/// library asks — and the two disagreeing is how a work ends up on a shelf it
/// has been read off.
const String markFinishedSql =
    'INSERT INTO reading (work_id, chapters_read, updated_at, opened_at) '
    "SELECT w.work_id, $chapters, datetime('now'), datetime('now') "
    'FROM works w WHERE w.work_id = ? '
    'ON CONFLICT(work_id) DO UPDATE SET '
    '  chapters_read = excluded.chapters_read, '
    '  updated_at = excluded.updated_at';

/// Taking it back. The place is kept; only the claim that it is done goes.
const String markUnfinishedSql =
    'UPDATE reading SET chapters_read = max(0, COALESCE(chapter, 1) - 1), '
    "updated_at = datetime('now') WHERE work_id = ?";

/// Where a chapter should open.
///
/// Only ever two answers: where this chapter was left off, or its beginning.
/// A remembered offset belongs to a chapter, so it counts only when the
/// chapter matches — anything else restores an offset from the chapter before
/// it and lands the reader somewhere arbitrary in one they have never seen.
double openingOffset({
  required int chapter,
  int? savedChapter,
  double? savedOffset,
  bool transient = false,
}) {
  if (transient) return 0;
  if (savedChapter != chapter) return 0;
  final y = savedOffset ?? 0;
  return y.isFinite && y > 0 ? y : 0;
}
