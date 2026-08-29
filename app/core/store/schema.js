/**
 * The shape of the archive on disk.
 *
 * Kept as SQL text rather than driver calls because two different SQLite
 * builds run it: node's built-in for tooling, and SQLite-WASM in the app.
 * One schema, so what the ingest writes is exactly what the reader queries.
 */

export const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS works (
  work_id        TEXT PRIMARY KEY,
  title          TEXT,
  authors        TEXT,          -- JSON array; a work can have several
  summary        TEXT,
  rating         TEXT,
  language       TEXT,
  published      TEXT,
  updated        TEXT,
  -- when this copy was taken from AO3; the answer to "is our copy current?"
  downloaded_at  TEXT,
  complete       INTEGER,
  words          INTEGER,
  chapter_count  INTEGER,
  chapters_planned INTEGER,
  -- AO3's epoch from the listing. The authority on "has this changed?", and
  -- the reason a sync can skip a work without fetching it.
  updated_at     INTEGER,
  skin_css       TEXT,
  skin_hash      TEXT,
  end_notes_html TEXT,   -- author's closing notes, shown after the last chapter
  source         TEXT,          -- 'epub' or 'ao3'
  source_file    TEXT,
  fetched_at     TEXT,
  in_bookmarks   INTEGER DEFAULT 0,
  -- a starred bookmark: the archive calls it a rec, and it is the strongest
  -- signal in the whole library of what someone actually thought was good
  rec            INTEGER DEFAULT 0,
  in_history     INTEGER DEFAULT 0,
  bookmarked_at  TEXT,
  last_visited   TEXT,
  visits         INTEGER,
  -- kudos can be left once and only once, and the archive gives no way to ask
  -- afterwards whether they were; remembering locally is the only way the
  -- button can ever say so
  kudos_given    INTEGER DEFAULT 0,
  -- what the archive reports about a work. Parsed all along and never kept,
  -- which left no way to ask for the best-liked thing in the library
  -- Whether the text is actually here.
  --
  -- A work can be known without being held: the listings describe thousands of
  -- works we have never downloaded, and describing one costs nothing while
  -- fetching it costs a request. A row with this at 0 is a work the reader can
  -- find, filter and read about, whose chapters arrive when they open it.
  has_text       INTEGER DEFAULT 0,
  kudos          INTEGER,
  bookmark_count INTEGER,
  hits           INTEGER
);

-- Tags are a many-to-many that gets queried by type constantly ("everything
-- tagged Fluff", "everything in this fandom"), so they are rows, not JSON.
CREATE TABLE IF NOT EXISTS tags (
  work_id TEXT NOT NULL,
  kind    TEXT NOT NULL,        -- fandom | relationship | character | freeform | warning | category
  name    TEXT NOT NULL,
  PRIMARY KEY (work_id, kind, name)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tags_by_name ON tags(kind, name);

CREATE TABLE IF NOT EXISTS chapters (
  id       INTEGER PRIMARY KEY,
  work_id  TEXT NOT NULL,
  number   INTEGER NOT NULL,
  title    TEXT,
  html     TEXT,                -- what the reader renders
  text     TEXT,                -- what search indexes
  words    INTEGER,
  content_hash TEXT,
  UNIQUE (work_id, number)
);
CREATE INDEX IF NOT EXISTS chapters_by_work ON chapters(work_id, number);

-- FTS4, not FTS5.
--
-- Android's SQLite has shipped FTS4 for years and FTS5 only recently, so a
-- device with no FTS5 loses search entirely — which is the feature this whole
-- archive exists for. FTS4 provides match, phrase, prefix, NEAR and snippet();
-- the one thing it lacks is bm25(), and that is computed from matchinfo() in
-- app/core/search.js so the ranking is identical everywhere.
--
-- External content: the index points at chapters.text rather than keeping a
-- second copy of 42 million words.
CREATE VIRTUAL TABLE IF NOT EXISTS chapter_fts USING fts4(
  content='chapters', text, tokenize=unicode61
);

-- Metadata search is a different question from full-text search ("a fic called
-- X" vs "a fic containing X"), so it gets its own small index.
CREATE VIRTUAL TABLE IF NOT EXISTS work_fts USING fts4(
  work_id, title, authors, summary, tags, tokenize=unicode61
);

-- Superseded copies. Authors revise, and a work you read in 2021 may not be
-- the work on AO3 today; without this an update silently destroys the version
-- you actually read.
CREATE TABLE IF NOT EXISTS chapter_versions (
  id          INTEGER PRIMARY KEY,
  work_id     TEXT NOT NULL,
  number      INTEGER NOT NULL,
  title       TEXT,
  html        TEXT,
  text        TEXT,
  words       INTEGER,
  content_hash TEXT,
  reason      TEXT,           -- content | removed
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS chapter_versions_by_work ON chapter_versions(work_id, number, archived_at);

CREATE TABLE IF NOT EXISTS skin_versions (
  id          INTEGER PRIMARY KEY,
  work_id     TEXT NOT NULL,
  skin_css    TEXT,
  skin_hash   TEXT,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS skin_versions_by_work ON skin_versions(work_id, archived_at);

CREATE TABLE IF NOT EXISTS images (
  work_id   TEXT NOT NULL,
  url       TEXT NOT NULL,
  sha256    TEXT,
  mime      TEXT,
  bytes     BLOB,
  status    TEXT,               -- stored | dead | pending
  fetched_at TEXT,
  PRIMARY KEY (work_id, url)
) WITHOUT ROWID;

-- Where you were, per work. Imported from an Archive Reader backup and then
-- maintained by this app: losing your place in a 100,000 word fic is the
-- difference between an app you keep and one you abandon.
CREATE TABLE IF NOT EXISTS reading (
  work_id        TEXT PRIMARY KEY,
  chapter        INTEGER,     -- furthest chapter with any progress
  offset         REAL,        -- scroll position within that chapter
  chapters_read  INTEGER,
  chapter_count  INTEGER,
  marked_later   INTEGER DEFAULT 0,
  imported_from  TEXT,
  updated_at     TEXT,
  -- when this app last had it open. A row here is not proof of reading: an
  -- import writes one for every work marked for later. This column is only
  -- ever written by opening a chapter, so it is what tells the two apart.
  opened_at      TEXT
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** Rebuilt in one pass after a bulk load — far cheaper than per-row triggers. */
export const REBUILD_FTS = `
INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild');
`;

/**
 * Bring an older database up to the shape the app queries.
 *
 * SCHEMA is applied with CREATE TABLE IF NOT EXISTS, which does nothing at all
 * to a table that already exists — so a column added here arrives for new
 * databases and for nobody else. Every tool that opens a library runs this
 * after applying the schema, and the Android shell does the same on open.
 *
 * Adding a column is the only migration attempted, and the only one needed so
 * far: SQLite records it in the table definition without touching a row, so it
 * is quick on a large library and safe to run every time.
 */
export function ensureColumns(db) {
  const declared = [...SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS works'))
    .split('\n);')[0]
    .matchAll(/^ {2}([a-z_]+)\s+(TEXT|INTEGER)([^,\n]*)/gm)]
    .map(([, name, type, rest]) => ({ name, ddl: `${type}${/DEFAULT/.test(rest) ? rest : ''}`.trim() }));

  const have = new Set(db.prepare('PRAGMA table_info(works)').all().map((r) => r.name));
  const added = [];
  for (const { name, ddl } of declared) {
    if (have.has(name)) continue;
    db.exec(`ALTER TABLE works ADD COLUMN ${name} ${ddl}`);
    added.push(name);
  }
  return added;
}
