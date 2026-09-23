/**
 * What a work owns, and the order it has to be let go of.
 *
 * A work is not one row. It is a row, its tags, its chapters, two search
 * indexes, the pictures fetched for it, the copies kept of chapters an author
 * revised, the skin it was published with, and where the reader had got to in
 * it. Deleting the work and leaving any of those behind is a library that
 * grows a little every time somebody tidies it.
 *
 * Two backends do this — the shell in Java, the dev server in JavaScript —
 * and neither can import the other's code, so the list lives here and a test
 * holds both to it. That is the same arrangement the reading predicate and the
 * bookmark reconciliation ended up with, for the same reason: the two of them
 * drifting is not a thing anybody notices until a phone is doing it.
 */

/**
 * The chapter index goes first, and by hand.
 *
 * chapter_fts is external-content FTS4 keyed on `chapters.rowid`. Deleting the
 * chapters first leaves index rows pointing at chapters that no longer exist,
 * and a search then finds a work that has been deleted and cannot open it. The
 * refetch path has always done this dance; a delete does it too.
 */
export const INDEX_FIRST = 'chapter_fts';

/** Then these, each by work_id, in one transaction. */
export const WORK_OWNS = [
  'chapters',
  'work_fts',
  'tags',
  'images',
  'chapter_versions',
  'skin_versions',
  'reading_visits',
  'reading',
  'works',
];

/** The statements, for a backend that can run them straight. */
export const deleteStatements = () =>
  WORK_OWNS.map((table) => `DELETE FROM ${table} WHERE work_id = ?`);

/**
 * And the tombstone, which is the half that makes it stay deleted.
 *
 * Written in the same transaction as the removal: a work that is gone from
 * the library and absent from here is a work the next listing quietly
 * restores, which is worse than not having deleted it at all — the reader
 * believes it is gone.
 */
export const TOMBSTONE =
  "INSERT OR REPLACE INTO deleted (work_id, title, at) VALUES (?, ?, datetime('now'))";
