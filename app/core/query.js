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
  /* When we got it. A fetched work sets fetched_at, and only the EPUB import
     ever set downloaded_at — so ordering by that alone put everything newly
     added at the very bottom of "recently added". */
  added: 'COALESCE(w.downloaded_at, w.fetched_at) DESC',
  words: 'w.words DESC',
  shortest: 'w.words ASC',
  chapters: 'w.chapter_count DESC',
  recent: 'r.updated_at DESC',
  /* NULLS LAST, spelled out: a work whose counts we have never seen should
     not outrank one with none, and in SQLite a NULL sorts first descending. */
  kudos: 'w.kudos IS NULL, w.kudos DESC',
  bookmarks: 'w.bookmark_count IS NULL, w.bookmark_count DESC',
  hits: 'w.hits IS NULL, w.hits DESC',
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
  rec: 'w.rec = 1',
  /* Whether the text is actually here. A listing describes thousands of works
     we have never downloaded; being able to ask for only what can be read now,
     or only what is still to fetch, is the point of keeping them apart. */
  held: 'w.has_text = 1',
  known: 'w.has_text = 0',
  bookmarked: 'w.in_bookmarks = 1',
  history: 'w.in_history = 1',
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
 *   updatedAfter / updatedBefore   YYYY-MM-DD, inclusive
 *   crossover  '1' more than one fandom, '0' exactly one
 *   otp        every relationship on the work is one of the included tags
 *   sort       one of SORTS
 */
/** Escape what LIKE would otherwise treat as a wildcard. */
function likeLiteral(text) {
  return String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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

  /* A restriction to a known set of works, used when a search supplies the
     candidates: the filters still apply on top, so searching inside the
     library never escapes the narrowing the reader has already done. */
  const ids = list(filters.ids);
  if (ids.length) {
    where.push(`w.work_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }

  /* Authors are stored as a JSON array on the work, so a name is matched as
     the quoted string it appears as inside it — JSON.stringify gives exactly
     that, escaping included, which is why the name is not spliced in raw. A
     bare LIKE on the name alone would match "Anna" inside "Annabel", and the
     surrounding quotes are what stop it. */
  const authors = list(filters.author);
  if (authors.length) {
    where.push(`(${authors.map(() => "w.authors LIKE ? ESCAPE '\\'").join(' OR ')})`);
    args.push(...authors.map((name) => `%${likeLiteral(JSON.stringify(String(name)))}%`));
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

  /*
   * When it last changed, which is the filter the archive offers and this did
   * not. The date is stored as the archive writes it — YYYY-MM-DD — so it
   * sorts and compares as text without parsing anything, and a work with no
   * updated date falls back to when it was posted, the same way the column
   * that displays it does.
   */
  if (filters.updatedAfter) {
    where.push('COALESCE(w.updated, w.published) >= ?');
    args.push(String(filters.updatedAfter).slice(0, 10));
  }
  if (filters.updatedBefore) {
    where.push('COALESCE(w.updated, w.published) <= ?');
    args.push(String(filters.updatedBefore).slice(0, 10));
  }

  /*
   * Crossovers: a work in more than one fandom. The archive treats this as a
   * yes-or-no of its own rather than something you assemble out of fandom
   * tags, because assembling it is the thing you cannot do — asking for two
   * fandoms gives works in both, and what you wanted was works in either that
   * are also in some second thing.
   */
  /*
   * Only this pairing.
   *
   * Choosing a relationship gives works that have it among others; what is
   * usually wanted is the ones that are about it. So: no relationship tag on
   * the work outside the ones asked for. Names that are not relationships are
   * harmlessly in the list — a work's relationship tags simply have to fall
   * within it.
   *
   * Meaningless with nothing chosen, where it would ask for works with no
   * relationships at all, so it needs something to be exact about.
   */
  const wanted = list(filters.include);
  if (filters.otp && wanted.length) {
    where.push(`NOT EXISTS (SELECT 1 FROM tags t WHERE t.work_id = w.work_id
                  AND t.kind = 'relationship'
                  AND t.name NOT IN (${wanted.map(() => '?').join(',')}))`);
    args.push(...wanted);
  }

  if (filters.crossover === '1') {
    where.push("(SELECT count(DISTINCT t.name) FROM tags t "
             + "WHERE t.work_id = w.work_id AND t.kind = 'fandom') > 1");
  } else if (filters.crossover === '0') {
    where.push("(SELECT count(DISTINCT t.name) FROM tags t "
             + "WHERE t.work_id = w.work_id AND t.kind = 'fandom') <= 1");
  }

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
                 w.rec, w.in_bookmarks, w.in_history, w.bookmarked_at,
                 w.kudos, w.bookmark_count, w.hits, w.has_text,
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
/**
 * Counting something a work holds in a column rather than in the tags table.
 *
 * A rating is not a tag here: the archive presents it as one, but it is one
 * value per work and it is stored as a column. The facets were built by
 * looping over the tag kinds, so ratings were never counted — and the panel
 * draws its Rating section only when it has counts to draw, which is to say
 * never. The filter behind it worked the whole time; there was simply no way
 * to reach it. Language had the same shape of hole.
 *
 * The column being filtered on is dropped from the counts, so choosing
 * Explicit does not make Mature disappear from the list you chose it from.
 */
const COLUMN_FACETS = { rating: 'w.rating', language: 'w.language' };

export function buildColumnFacet(filters = {}, column) {
  const col = COLUMN_FACETS[column];
  if (!col) throw new Error(`unknown column facet: ${column}`);
  const without = { ...filters, limit: 1, offset: 0 };
  delete without[column];
  const base = buildWorksQuery(without);
  const inner = base.countSql.replace('SELECT count(*) AS n ', 'SELECT w.work_id ');
  return {
    args: base.args,
    sql: `SELECT ${col} AS name, count(*) AS n FROM works w
          WHERE ${col} IS NOT NULL AND ${col} <> '' AND w.work_id IN (${inner})
          GROUP BY ${col} ORDER BY n DESC, ${col}`,
  };
}

/**
 * Who wrote them, counted.
 *
 * Authors are a JSON array on the work rather than rows in the tags table, so
 * counting them needs json_each. That is present in every SQLite this app is
 * likely to meet and absent from the oldest it will run on, so the caller is
 * expected to try it and do without the section if it fails — an Authors
 * filter is worth having and not worth a blank screen.
 */
export function buildAuthorFacet(filters = {}, limit = 40, needle = '') {
  const base = buildWorksQuery({ ...filters, author: [], limit: 1, offset: 0 });
  const inner = base.countSql.replace('SELECT count(*) AS n ', 'SELECT w.work_id ');
  const args = [...base.args];
  /* Searching has to reach past the top of the list. A library holds far more
     names than anyone wants to scroll, so the panel shows the busiest handful
     — and typing used to sift only that handful, which meant every author
     outside it could not be found at all. */
  let match = '';
  if (needle) {
    match = " AND j.value LIKE ? ESCAPE '\\'";
    args.push(`%${likeLiteral(needle)}%`);
  }
  return {
    args,
    sql: `SELECT j.value AS name, count(*) AS n
            FROM works w, json_each(w.authors) j
           WHERE w.work_id IN (${inner})${match}
           GROUP BY j.value ORDER BY n DESC, j.value LIMIT ${int(limit, 40, 500)}`,
  };
}

/** How many distinct authors there are, which is not how many are shown. */
export function buildAuthorCount(filters = {}) {
  const base = buildWorksQuery({ ...filters, author: [], limit: 1, offset: 0 });
  const inner = base.countSql.replace('SELECT count(*) AS n ', 'SELECT w.work_id ');
  return {
    args: base.args,
    sql: `SELECT count(*) AS n FROM (
            SELECT DISTINCT j.value FROM works w, json_each(w.authors) j
             WHERE w.work_id IN (${inner}))`,
  };
}

export function buildFacetQuery(filters = {}, kind, limit = 30, needle = '') {
  if (!TAG_KINDS.includes(kind)) throw new Error(`unknown tag kind: ${kind}`);
  const base = buildWorksQuery({ ...filters, limit: 1, offset: 0 });
  const inner = base.countSql.replace('SELECT count(*) AS n ', 'SELECT w.work_id ');
  const args = [...base.args];
  let match = '';
  if (needle) {
    match = " AND t.name LIKE ? ESCAPE '\\'";
    args.push(`%${likeLiteral(needle)}%`);
  }
  return {
    args,
    sql: `SELECT t.name, count(*) AS n FROM tags t
          WHERE t.kind = '${kind}' AND t.work_id IN (${inner})${match}
          GROUP BY t.name ORDER BY n DESC, t.name LIMIT ${int(limit, 30, 500)}`,
  };
}
