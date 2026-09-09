# Deleting works, blocking authors, and seeing whose bookmarks a work is in

Three wants, in one design because they share a mechanism:

1. delete a work;
2. see an author's bookmarks as well as their works;
3. delete everything of an author's and never see them again.

## The state of things now

Nothing in this app deletes anything. There is no `DELETE FROM works`
anywhere — not in the shell, not in the dev server, not in the tools. A
library only ever grows, and the only way to lose a work is to lose the
database.

`works.in_bookmarks` is a boolean meaning *yours*. When `walkAuthor` reads
somebody else's bookmark index it saves a stub for every work it sees and
then throws away the one fact that made the page worth reading: whose list
it was. So "ann's bookmarks" cannot be asked of the library at all, even
for authors whose bookmarks have already been walked.

`openAuthor` filters the library by *authorship* — `w.authors LIKE '%"ann"%'`
— so the author view has exactly one thing it can show.

## Decisions

Taken with the user before any of this was written.

**Delete means gone, and stays gone.** Text, chapters, images and the row
all go, and the work is remembered as deleted so a bookmark sync or an
author walk never brings it back. Reversible, but only by deliberately
allowing it again from a list of what was removed.

**Blocking means never fetch, never show — unless someone else wrote it
too.** A work solely by a blocked author is hidden; a collaboration with
somebody else stays visible. Blocking a person should not cost you a
co-written work you like.

**Seeing an author's bookmarks changes nothing about downloading.** The
existing buttons keep their existing behaviour and costs. The new thing is
a place to look, filled in by the walks those buttons already run.

**Deleting an author's works and blocking them is one action**, behind one
confirmation naming what it is about to remove.

## 1. Deleting a work

A work owns rows in eight places. All of them go, in one transaction:

    chapter_fts    by chapter rowid, before the rows it points at
    chapters
    work_fts       by work_id
    tags
    images
    chapter_versions
    skin_versions
    reading
    works

The chapter_fts ordering is not a detail: the index is external-content
FTS4 keyed on `chapters.rowid`, so deleting the chapters first leaves index
entries pointing at rows that no longer exist. The refetch path in
`MainActivity.storeWork` already does this dance, and a delete follows it.

### The tombstone

    CREATE TABLE deleted (
      work_id TEXT PRIMARY KEY,
      title   TEXT,          -- so the undo list can name what it holds
      at      TEXT
    );

Everything that can bring a work in unasked consults it:

- `needsFetching(works)` — the funnel every walk passes through
- `saveStubs(...)` — so a listing cannot re-create the row
- the new-bookmarks walk
- `stubIds()`, the not-downloaded backlog

**Adding by link does not.** Pasting a link is somebody asking for this
work today, which outranks a refusal made last month: it clears the
tombstone and fetches. A refusal that cannot be revoked by asking plainly
is a bug, not a safeguard.

### Undo

Settings gains **Removed**: what was deleted, when, and *allow again*,
which drops the tombstone. The work itself is gone; allowing it again means
the next walk or an opened link may fetch it afresh.

## 2. The blocklist

    CREATE TABLE blocked (name TEXT PRIMARY KEY, at TEXT);

and a derived column on `works`:

    hidden INTEGER DEFAULT 0     -- every author of this work is blocked

### Why derived rather than computed

`works.authors` is a JSON array inside a text column. "Every author is
blocked" needs to parse it, and Android's SQLite may not have JSON1 —
this project already runs FTS4 rather than FTS5 for exactly that reason. A
predicate that works on a developer's machine and not on the phone is the
failure mode this codebase has paid for most.

So `hidden` is computed in JavaScript, where the JSON parses, and written
down. It is recomputed on block, on unblock, and whenever a work is
written. A single-author work by a blocked author is hidden; a
collaboration is not.

### One predicate, two places

`w.hidden = 0` goes into `buildWorksQuery` and into the `shelf` helper that
`api.js` and `serve.mjs` share. Those are the two places `STATES.reading`
had to live before Home and the Library could stop disagreeing about what
"reading" meant; a blocked author must not be hidden from one and offered
by the other.

### Acquisition

`walkAuthor` refuses a blocked name outright, and `needsFetching` drops
works whose authors are all blocked — so a blocked person reached through
somebody else's bookmarks is not fetched either.

Settings lists blocked authors with unblock, which clears `hidden` for
their works.

## 3. Delete their works and block them

One control on the author bar, behind a confirmation naming the number of
works and the total words. It deletes works **solely** theirs — keeping
collaborations, to match the hiding rule — and then blocks the name.

One local transaction. No archive requests, so not a queue job: the queue
is for work the archive is being asked for.

## 4. An author's bookmarks

    CREATE TABLE bookmarked_by (
      person  TEXT NOT NULL,
      work_id TEXT NOT NULL,
      at      TEXT,
      PRIMARY KEY (person, work_id)
    ) WITHOUT ROWID;

`walkAuthor(name, {listing: 'bookmarks'})` already saves a stub for every
work on every page it reads. It records membership in the same pass. No
extra requests, no change to what downloads or when.

The author bar gains a **Works | Bookmarks** switch. Works is the existing
author filter; Bookmarks is a new `bookmarkedBy` filter in
`buildWorksQuery`.

**It fills in going forward.** For an author walked before this exists the
tab is empty, because the membership was discarded at the time and cannot
be recovered without reading their index again. The empty state says so,
and names the button that would do it.

## Migration

New tables — `deleted`, `blocked`, `bookmarked_by` — and one new column,
`works.hidden`.

`SCHEMA` creates the tables for a new library. An existing one is brought
forward by `ensureColumns` on the JS side and `migrate()` in the shell,
which must create the three tables as it already creates `meta`, and add
`hidden` to `WORKS_COLUMNS`. The drift test that holds `READING_COLUMNS` to
the schema covers the works columns the same way.

## Testing

- `query.test.mjs`: hidden works are absent from every state; a
  collaboration with a blocked author is not hidden; `bookmarkedBy` selects
  what a walk recorded.
- A behavioural test of the delete statement against a real in-memory
  database: every table that referenced the work is empty afterwards, and
  the FTS index has no entry pointing at a chapter that is gone.
- A drift guard holding the shell's delete SQL to the dev server's, as the
  bookmark reconciliation and the chapter total are held now.
- `migrate.test.mjs`: the three tables and the column arrive for an old
  library.
- Source guards for the enforcement points: nothing that can fetch a work
  may skip the tombstone or the blocklist.

## Shipping

Four changes, one release each, in this order:

1. delete a work, the tombstone, and Removed in settings;
2. the blocklist, `hidden`, and Blocked in settings;
3. delete-and-block on the author bar (needs 1 and 2);
4. `bookmarked_by` and the Works / Bookmarks switch (independent).
