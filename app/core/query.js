/**
 * Building the library query from a set of filters.
 *
 * Shared deliberately. The dev server and the native bridge previously each
 * had their own copy of this logic, and they drifted — routes existed on one
 * and not the other, and the app failed on a real device in ways no test could
 * see. One builder, two callers.
 *
 * Nothing a reader types is ever concatenated into SQL. Column and sort names
 * come from the maps below and are looked up, never interpolated; every value
 * is bound. The only interpolated things are integers this module has already
 * validated.
 */

export const SORTS = {
  title: 'w.title COLLATE NOCASE ASC',
  author: 'w.authors COLLATE NOCASE ASC',
  updated: 'COALESCE(w.updated, w.published) DESC',
  published: 'w.published DESC',
  added: 'w.downloaded_at DESC',
  words: 'w.words DESC',
  shortest: 'w.words ASC',
  chapters: 'w.chapter_count DESC',
  recent: 'r.updated_at DESC',
  random: 'RANDOM()',
};

/** Reading state, which lives in the reading table rather than on the work. */
export const STATES = {
  all: '1=1',
  reading: '(COALESCE(r.chapters_read, 0) > 0 OR COALESCE(r.chapter, 0) > 1) '
    + 'AND COALESCE(r.chapters_read, 0) < w.chapter_count',
  unread: 'COALESCE(r.chapters_read, 0) = 0 AND COALESCE(r.chapter, 0) <= 1',
  finished: 'r.chapters_read >= w.chapter_count AND w.chapter_count > 0',
  later: 'r.marked_later = 1',
};

export const TAG_KINDS = ['fandom', 'relationship', 'character', 'freeform', 'warning', 'category'];

/** An integer we are willing to write into SQL, having checked it is one. */
const int = (value, fallback, max) => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return max === undefined ? n : Math.min(n, max);
};

const list = (value) => {
  if (value == null || value === '') return [];
  return (Array.isArray(value) ? value : String(value).split('\t'))
    .map((v) => String(v).trim()).filter(Boolean);
};

/**
 * @param filters
 *   state      one of STATES
 *   include[]  tags a work must have (AND — every one of them)
 *   exclude[]  tags a work must not have
 *   rating[]   any of these ratings (OR)
 *   language   exact match
 *   complete   '1' | '0'
 *   wordsMin / wordsMax, chaptersMin / chaptersMax
 *   sort       one of SORTS
 */
export function buildWorksQuery(filters = {}) {
  const where = ['1=1'];
  const args = [];

  where.push(STATES[filters.state] ?? STATES.all);

  /* Included tags are an AND: "alpha/beta/omega" *and* "slow burn" is a much
     more useful question than either alone, and it is the one AO3's own filters
     answer. One EXISTS per tag rather than an IN(...) with a count, because it
     reads honestly and SQLite plans it well against the tags index. */
  for (const tag of list(filters.include)) {
    where.push('EXISTS (SELECT 1 FROM tags t WHERE t.work_id = w.work_id AND t.name = ?)');
    args.push(tag);
  }
  for (const tag of list(filters.exclude)) {
    where.push('NOT EXISTS (SELECT 1 FROM tags t WHERE t.work_id = w.work_id AND t.name = ?)');
    args.push(tag);
  }

  const ratings = list(filters.rating);
  if (ratings.length) {
    where.push(`w.rating IN (${ratings.map(() => '?').join(',')})`);
    args.push(...ratings);
  }

  if (filters.language) { where.push('w.language = ?'); args.push(String(filters.language)); }

  if (filters.complete === '1' || filters.complete === 1 || filters.complete === true) {
    where.push('w.complete = 1');
  } else if (filters.complete === '0' || filters.complete === 0 || filters.complete === false) {
    where.push('w.complete = 0');
  }

  // ranges are bound, not interpolated, so a nonsensical one is simply no match
  if (filters.wordsMin) { where.push('w.words >= ?'); args.push(int(filters.wordsMin, 0)); }
  if (filters.wordsMax) { where.push('w.words <= ?'); args.push(int(filters.wordsMax, 0)); }
  if (filters.chaptersMin) { where.push('w.chapter_count >= ?'); args.push(int(filters.chaptersMin, 0)); }
  if (filters.chaptersMax) { where.push('w.chapter_count <= ?'); args.push(int(filters.chaptersMax, 0)); }

  const order = SORTS[filters.sort] ?? SORTS.title;
  const limit = int(filters.limit, 50, 200);
  const offset = int(filters.offset, 0, 1_000_000);

  const from = `FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
                WHERE ${where.join(' AND ')}`;

  return {
    args,
    countSql: `SELECT count(*) AS n ${from}`,
    sql: `SELECT w.work_id, w.title, w.authors, w.summary, w.words, w.chapter_count,
                 w.chapters_planned, w.complete, w.rating, w.published, w.updated,
                 w.downloaded_at, w.language,
                 w.skin_css IS NOT NULL AND w.skin_css <> '' AS has_skin,
                 r.chapter AS at_chapter, r.chapters_read, r.marked_later,
                 (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1) AS fandom,
                 (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'relationship' LIMIT 1) AS relationship
          ${from} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
  };
}

/**
 * Tags available within the current filter set, with counts.
 *
 * Counting against the filtered set rather than the whole library is what makes
 * a filter panel usable: it shows what narrowing further would actually leave,
 * so no reader ever picks a combination that yields nothing.
 */
export function buildFacetQuery(filters = {}, kind, limit = 30) {
  if (!TAG_KINDS.includes(kind)) throw new Error(`unknown tag kind: ${kind}`);
  const base = buildWorksQuery({ ...filters, limit: 1, offset: 0 });
  const inner = base.countSql.replace('SELECT count(*) AS n ', 'SELECT w.work_id ');
  return {
    args: base.args,
    sql: `SELECT t.name, count(*) AS n FROM tags t
          WHERE t.kind = '${kind}' AND t.work_id IN (${inner})
          GROUP BY t.name ORDER BY n DESC, t.name LIMIT ${int(limit, 30, 200)}`,
  };
}
