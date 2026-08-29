/**
 * Folding one library into another.
 *
 * Importing used to be a file copy: the chosen database was written straight
 * over the device's, which is why nothing was ever versioned by it. No row was
 * ever read, so there was nothing for versioning to happen to — and everything
 * that existed only on the device went with it. Reading positions, kudos left
 * from the app, works added there by pasting a link.
 *
 * This reads the incoming library and folds it in, work by work. What the
 * archive knows comes from the incoming copy; what only the device knows stays
 * on the device.
 *
 * The steps are SQL and nothing else, so the same statements run here under a
 * test and on the phone through the shell. The incoming file is attached as
 * `incoming`.
 */

/** Columns describing the work itself, which the incoming copy is authoritative for. */
const WORK_COLUMNS = [
  'title', 'authors', 'summary', 'rating', 'language', 'published', 'updated',
  'downloaded_at', 'complete', 'words', 'chapter_count', 'chapters_planned',
  'updated_at', 'skin_css', 'skin_hash', 'end_notes_html', 'source', 'source_file',
  'fetched_at', 'in_bookmarks', 'rec', 'in_history', 'bookmarked_at',
  'kudos', 'bookmark_count', 'hits',
];

/*
 * Deliberately absent from that list: kudos_given, last_visited and visits.
 *
 * Kudos left from the app are recorded nowhere else — the archive offers no way
 * to ask afterwards whether they were given — so an import that overwrote the
 * flag would make the button offer to leave them a second time. The visit
 * counters are the device's own record of reading.
 */

export const MERGE_STEPS = [
  /* Chapters about to change, kept first. The comparison ignores whitespace
     for the same reason the other paths do: a reflowed paragraph is not a
     revision, and archiving one would bury the real changes. */
  `INSERT INTO chapter_versions (work_id, number, title, html, text, words, reason, archived_at)
     SELECT c.work_id, c.number, c.title, c.html, c.text, c.words, 'content', datetime('now')
       FROM chapters c
       JOIN incoming.chapters i ON i.work_id = c.work_id AND i.number = c.number
      WHERE replace(replace(replace(c.html, char(10), ' '), char(13), ' '), '  ', ' ')
         <> replace(replace(replace(i.html, char(10), ' '), char(13), ' '), '  ', ' ')`,

  /* Chapters the incoming copy no longer has. A work that arrives in a
     different shape — the archive restructured, or an import that invented
     chapters being corrected — must not take the old text with it. */
  `INSERT INTO chapter_versions (work_id, number, title, html, text, words, reason, archived_at)
     SELECT c.work_id, c.number, c.title, c.html, c.text, c.words, 'removed', datetime('now')
       FROM chapters c
      WHERE c.work_id IN (SELECT work_id FROM incoming.works)
        AND NOT EXISTS (SELECT 1 FROM incoming.chapters i
                         WHERE i.work_id = c.work_id AND i.number = c.number)`,

  /* Versions the incoming copy holds that this one does not. Two libraries that
     have each watched a work change should end up knowing about both changes. */
  `INSERT INTO chapter_versions (work_id, number, title, html, text, words, content_hash, reason, archived_at)
     SELECT v.work_id, v.number, v.title, v.html, v.text, v.words, v.content_hash, v.reason, v.archived_at
       FROM incoming.chapter_versions v
      WHERE NOT EXISTS (SELECT 1 FROM chapter_versions m
                         WHERE m.work_id = v.work_id AND m.number = v.number
                           AND m.archived_at = v.archived_at)`,

  `INSERT INTO skin_versions (work_id, skin_css, skin_hash, archived_at)
     SELECT s.work_id, s.skin_css, s.skin_hash, s.archived_at
       FROM incoming.skin_versions s
      WHERE NOT EXISTS (SELECT 1 FROM skin_versions m
                         WHERE m.work_id = s.work_id AND m.archived_at = s.archived_at)`,

  /* The works themselves: everything the archive knows, nothing the device
     does. The `WHERE true` is not decoration — SQLite cannot otherwise tell
     whether the ON introduces the upsert or a join, and refuses to parse it. */
  `INSERT INTO works (work_id, ${WORK_COLUMNS.join(', ')})
     SELECT work_id, ${WORK_COLUMNS.join(', ')} FROM incoming.works WHERE true
   ON CONFLICT(work_id) DO UPDATE SET
     ${WORK_COLUMNS.map((c) => `${c} = excluded.${c}`).join(',\n     ')}`,

  // tags belong to the work, so they arrive with it
  `DELETE FROM tags WHERE work_id IN (SELECT work_id FROM incoming.works)`,
  `INSERT OR IGNORE INTO tags (work_id, kind, name)
     SELECT work_id, kind, name FROM incoming.tags`,

  // chapters, now that anything they replace has been kept
  `DELETE FROM chapters WHERE work_id IN (SELECT work_id FROM incoming.works)`,
  `INSERT INTO chapters (work_id, number, title, html, text, words, content_hash)
     SELECT work_id, number, title, html, text, words, content_hash FROM incoming.chapters`,

  `INSERT OR IGNORE INTO images (work_id, url, sha256, mime, bytes, status, fetched_at)
     SELECT work_id, url, sha256, mime, bytes, status, fetched_at FROM incoming.images`,

  /* Reading positions only where the device has none. Somewhere in a work beats
     a record of never having opened it, and the device is where the reading
     actually happened. */
  /* offset and opened_at travel with the rest: without the first, restoring a
     backup puts you at the top of a chapter you were halfway down, and without
     the second every work falls off the Continue reading shelf. */
  `INSERT INTO reading (work_id, chapter, offset, chapters_read, marked_later,
                        updated_at, opened_at)
     SELECT r.work_id, r.chapter, r.offset, r.chapters_read, r.marked_later,
            r.updated_at, r.opened_at
       FROM incoming.reading r
      WHERE NOT EXISTS (SELECT 1 FROM reading m WHERE m.work_id = r.work_id)`,
];

/** The search index has to be rebuilt for whatever changed. */
export const REINDEX_STEPS = [
  `DELETE FROM chapter_fts`,
  `INSERT INTO chapter_fts (rowid, text) SELECT id, text FROM chapters`,
  `DELETE FROM work_fts`,
  `INSERT INTO work_fts (rowid, work_id, title, authors, summary, tags)
     SELECT rowid, work_id, title, authors, summary, '' FROM works`,
];
