/**
 * Searching, in the four places a reader searches from.
 *
 * One handler that always searched every word of every chapter answered only
 * one of these questions, and answered it everywhere — so typing an author's
 * name into the library returned the fourteen chapters that happen to mention
 * it rather than their works. What a search should look at depends entirely on
 * where it was typed:
 *
 *   everything  the home screen. Works, tags worth narrowing by, and passages,
 *               grouped, because the reader has not yet decided what they want.
 *   meta        the library. Titles, authors, summaries and tags only, within
 *               whatever filters are already applied.
 *   text        the search tab. The full text of every chapter held.
 *   work        inside a work. The full text of that work alone.
 *
 * Both backends call this with their own `sql` runner so the phone and the dev
 * server cannot drift apart — the last time a query lived in two places, they
 * did.
 */

import { rank, CANDIDATES } from './search.js';
import { buildWorksQuery } from './query.js';

/** Clamped, then interpolated: Android binds every argument as text, and
    SQLite will not take text where LIMIT needs an integer. */
const lim = (n, fallback, max) => {
  const v = Number.parseInt(n, 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : fallback;
};

/**
 * FTS4 has no notion of a half-typed word, so a trailing `*` is what makes
 * search feel live: "aster" finds "asteroid" while the reader is still typing.
 * A query that is already doing something deliberate — a quoted phrase, a
 * boolean — is left exactly as written.
 */
export function ftsQuery(q) {
  return /["*]/.test(q) || /\b(AND|OR|NOT|NEAR)\b/.test(q) ? q : `${q}*`;
}

/** Candidates ranked for the passage preview on the discovery screen. Enough
    to rank honestly, small enough to stay live under a typing finger. */
const DISCOVERY_POOL = 150;

const PASSAGES = `
  SELECT c.work_id, c.number, w.title, w.authors,
         snippet(chapter_fts, '<mark>', '</mark>', '…', -1, 18) AS snippet,
         matchinfo(chapter_fts, 'pcnalx') AS matchinfo
    FROM chapter_fts
    JOIN chapters c ON c.id = chapter_fts.docid
    JOIN works w ON w.work_id = c.work_id
   WHERE chapter_fts MATCH ?`;

export function search(sql, q, scope = 'text', options = {}) {
  const query = (q ?? '').trim();
  if (!query) return { hits: [], works: [], tags: [], scope };
  const match = ftsQuery(query);
  const limit = lim(options.limit, 40, 100);

  const passages = (where = '', args = [], take = limit, pool = CANDIDATES) =>
    rank(sql(`${PASSAGES}${where} LIMIT ${pool}`, [match, ...args]), take);

  if (scope === 'work') {
    if (!options.workId) return { hits: [], works: [], tags: [], scope };
    return { hits: passages(' AND c.work_id = ?', [options.workId]), works: [], tags: [], scope };
  }

  if (scope === 'meta') {
    /* The match supplies candidates; the filters, applied through the same
       builder the library itself uses, decide which survive — so a search
       result is sorted, shaped and counted exactly like an unsearched one. */
    const ids = sql(`SELECT work_id FROM work_fts WHERE work_fts MATCH ? LIMIT ${CANDIDATES}`,
      [match]).map((r) => r.work_id);
    if (!ids.length) return { hits: [], works: [], tags: [], scope };
    const built = buildWorksQuery({ ...options.filters, ids, limit });
    return { hits: [], works: sql(built.sql, built.args), tags: [], scope };
  }

  if (scope === 'everything') {
    /* Passages are the expensive third of this. A one-letter prefix matches
       nearly every chapter in the library, so ranking a full candidate pool
       for it costs hundreds of milliseconds on every keystroke and tells the
       reader nothing they could not get from the works and tags beside it.
       Below three characters the text is left alone; above it, a smaller pool,
       because this is a glimpse of the full-text search rather than the search
       itself — the search tab still ranks the whole pool. */
    const worthScanning = query.length >= 3;
    const ids = sql('SELECT work_id FROM work_fts WHERE work_fts MATCH ? LIMIT 8', [match])
      .map((r) => r.work_id);
    const built = ids.length ? buildWorksQuery({ ids, limit: 8, sort: 'words' }) : null;
    return {
      scope,
      works: built ? sql(built.sql, built.args) : [],
      // tags are matched as substrings: a reader typing "steve" wants
      // "Steve Rogers", which no prefix match on the tag would ever find
      tags: sql(`SELECT name, kind, count(*) AS n FROM tags WHERE name LIKE ?
                 GROUP BY name, kind ORDER BY n DESC LIMIT 6`, [`%${query}%`]),
      hits: worthScanning ? passages('', [], 10, DISCOVERY_POOL) : [],
    };
  }

  return { hits: passages(), works: [], tags: [], scope };
}
