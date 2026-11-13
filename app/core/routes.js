/**
 * Every question the app asks of a library, in one place.
 *
 * The app answered these itself, through the bridge to Android's SQLite, and
 * the dev server answered them again in its own words over HTTP. Two copies
 * of each query meant a browser test proved the server's copy and said
 * nothing about the one that ships. Both now call this, handing in the only
 * thing that differs between them: how a query reaches a database.
 *
 * `sql(query, args)` returns rows. Arguments arrive as the caller gives them;
 * the Android side binds everything as text, which is why counts are written
 * into the SQL by `lim()` and never bound.
 */
import { FF_VISITS } from './store/visits.js';
import { renderChapter, sanitiseHtml } from './render.js';
import { search } from './discover.js';
import { buildWorksQuery, buildFacetQuery, buildColumnFacet, buildAuthorFacet, buildAuthorCount, TAG_KINDS, STATES, COMPLETED, shown } from './query.js';

/** A count safe to inline: an integer, clamped, never reader-supplied text. */
const lim = (n, fallback = 50, max = 500) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v >= 0 ? Math.min(v, max) : fallback;
};

const WORK = '((?:\\d+|epub-[a-z0-9]+))';

/** Thrown by a route that needs rows it does not have yet. */
class Awaiting extends Error {
  constructor(promise) { super('awaiting a query'); this.promise = promise; }
}

/**
 * The same routes, over a database that answers later.
 *
 * On the phone a query crosses a bridge, and the page did nothing else while
 * it waited: no tap acknowledged, no animation started, until SQLite came
 * back. Asking without waiting needs the routes to pause mid-way, and they
 * are written straight through, thirty queries of them.
 *
 * So they are run as written. A query whose rows are not in hand yet throws;
 * that query is awaited, its rows are kept, and the route is run again from
 * the top, this time getting further. Every query still runs exactly once,
 * and a route is only reads, so starting it again changes nothing.
 */
export function createAsyncReadRoutes(sqlAsync) {
  async function read(path) {
    const answers = new Map();
    const sql = (query, args = []) => {
      const key = `${query}\u0000${JSON.stringify(args)}`;
      const known = answers.get(key);
      if (known) {
        if (known.error) throw known.error;
        return known.rows;
      }
      throw new Awaiting(Promise.resolve().then(() => sqlAsync(query, args)).then(
        (rows) => { answers.set(key, { rows }); },
        (error) => { answers.set(key, { error }); }));
    };
    const routes = createReadRoutes(sql);
    // Far more passes than any route has queries; a route that never settles is a fault, not a wait.
    for (let pass = 0; pass < 400; pass++) {
      try {
        return routes.read(path);
      } catch (e) {
        if (!(e instanceof Awaiting)) throw e;
        await e.promise;
      }
    }
    throw new Error(`a read did not settle: ${path}`);
  }
  return { read };
}

/* A route that catches its own errors must let a wait through, or it would
   answer "nothing found" for rows that are merely on their way. */
const waiting = (e) => { if (e instanceof Awaiting) throw e; };

export function createReadRoutes(sql) {
  const one = (query, args) => sql(query, args)[0] ?? null;

  const LOCAL = {
    '/api/works': (params) => {
      const filters = { ...params };
      if (params.tag) {
        filters.include = filters.include ? `${filters.include}\t${params.tag}` : params.tag;
      }
      const q = buildWorksQuery(filters);
      return {
        total: sql(q.countSql, q.args)[0].n,
        works: sql(q.sql, q.args),
      };
    },

    /**
     * The home screen, computed locally.
     *
     * This existed only on the dev server, so the APK asked for a route that was
     * not there and the whole home view failed with "no route for /api/home".
     * Anything the server can answer, the bridge has to answer too — that is the
     * entire point of the seam.
     */
    home: () => {
      /*
       * A shelf, and how much of it is not on it.
       *
       * Twelve works at most, with nothing anywhere saying so — twenty active
       * works showed as twelve and the other eight looked lost rather than
       * folded away. See all is the way to the rest, and it can only be trusted
       * if the shelf admits there is a rest.
       */
      const shelf = (where, order, limit = 12) => ({
        works: sql(`
        SELECT w.work_id, w.title, w.authors, w.summary, w.words, w.chapter_count, w.complete, w.rating,
               w.rec, w.visits, ${FF_VISITS} AS ff_visits,
               r.chapter AS at_chapter, r.chapters_read, r.marked_later,
               r.opened_at, r.offset, r.completed_before, w.has_text,
               (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'fandom' LIMIT 1) AS fandom,
               (SELECT name FROM tags t WHERE t.work_id = w.work_id AND t.kind = 'relationship' LIMIT 1) AS relationship
        FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
        WHERE ${shown(where)} ORDER BY ${order} LIMIT ${lim(limit, 12)}`),
        total: sql(`SELECT count(*) AS n FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
                    WHERE ${shown(where)}`)[0].n,
      });

      const totals = sql('SELECT count(*) AS works, COALESCE(sum(words),0) AS words FROM works w '
        + 'WHERE COALESCE(w.hidden, 0) = 0')[0];
      const read = sql(`
        SELECT COALESCE(sum(CASE WHEN ${COMPLETED} THEN w.words ELSE 0 END),0) AS words,
               count(CASE WHEN ${COMPLETED} THEN 1 END) AS finished
        FROM works w JOIN reading r ON r.work_id = w.work_id
        WHERE COALESCE(w.hidden, 0) = 0`)[0];

      const top = (kind, limit) => sql(
        `SELECT t.name, count(*) AS n FROM tags t JOIN works w ON w.work_id = t.work_id
         WHERE t.kind = ? AND COALESCE(w.hidden, 0) = 0
         GROUP BY t.name ORDER BY n DESC LIMIT ${lim(limit, 12)}`,
        [kind]);

      return {
        stats: {
          works: totals.works, words: totals.words,
          finished: read.finished, wordsRead: read.words,
          later: sql('SELECT count(*) AS n FROM reading WHERE marked_later = 1')[0].n,
        },
        shelves: [
          { key: 'reading', title: 'Continue reading',
            ...shelf(
              /* The Library's Reading filter and nothing else — see STATES in
                 core/query.js. These were two hand-written predicates that
                 disagreed, so a work could sit on this shelf and then vanish
                 when See all asked the same question in the other file's words. */
              STATES.reading,
              /* Most recently opened first, whichever shelf it was opened from. */
              'COALESCE(r.opened_at, r.updated_at) DESC') },
          { key: 'later', title: 'Marked for later',
            ...shelf('r.marked_later = 1', 'w.title COLLATE NOCASE') },
          { key: 'added', title: 'Recently added',
            /* New to this library, whenever the work itself was written. A book
               read off a file is new here today even if the export is a year
               old, which is the whole reason these are two dates. */
            ...shelf('1=1', 'COALESCE(w.fetched_at, w.downloaded_at) DESC') },
          { key: 'updated', title: 'Updated on the archive',
            /* And the other question: what has the author changed lately. A
               work with no updated date has not been changed since it was
               posted, so it has no business on a shelf about changes. */
            ...shelf('w.updated IS NOT NULL', 'w.updated DESC') },
          { key: 'long', title: 'Settle in',
            ...shelf(`w.complete = 1 AND ${STATES.unread}`, 'w.words DESC') },
          { key: 'short', title: 'One sitting',
            ...shelf(`w.complete = 1 AND w.words < 5000 AND ${STATES.unread}`, 'RANDOM()') },
        ].filter((sh) => sh.works.length),
        browse: {
          fandom: top('fandom', 14), relationship: top('relationship', 14),
          character: top('character', 12), freeform: top('freeform', 14),
          rating: sql(`SELECT rating AS name, count(*) AS n FROM works w
                       WHERE rating IS NOT NULL AND rating <> '' AND COALESCE(w.hidden, 0) = 0
                       GROUP BY rating ORDER BY n DESC`),
        },
      };
    },

    surprise: () => ({
      work_id: sql(`SELECT w.work_id FROM works w LEFT JOIN reading r ON r.work_id = w.work_id
                    WHERE ${shown(STATES.unread)} ORDER BY RANDOM() LIMIT 1`)[0]?.work_id ?? null,
    }),

    /**
     * One section's options, searched across the whole library.
     *
     * The panel shows the busiest handful of each kind, and typing used to sift
     * only that handful — so an author or a tag outside the top of the list
     * could not be found at all. A search asks the database instead.
     */
    facetSearch: ({ kind, q = '', ...filters }) => {
      if (kind === 'author') {
        try {
          const built = buildAuthorFacet(filters, 60, q);
          return { items: sql(built.sql, built.args) };
        } catch (e) { waiting(e); return { items: [] }; }
      }
      const built = buildFacetQuery(filters, kind, 60, q);
      return { items: sql(built.sql, built.args) };
    },

    facets: (filters = {}) => {
      const counts = {};
      for (const state of Object.keys(STATES)) {
        const q = buildWorksQuery({ ...filters, state });
        counts[state] = sql(q.countSql, q.args)[0].n;
      }
      const tags = {};
      for (const kind of TAG_KINDS) {
        const q = buildFacetQuery(filters, kind, 40);
        tags[kind] = sql(q.sql, q.args);
      }
      /* Rating and language are counted from the work itself rather than from
         its tags. The panel draws those sections only when it has counts for
         them, and nothing was working them out — so they never appeared, and
         the filters behind them could not be reached. */
      for (const column of ['rating', 'language']) {
        const q = buildColumnFacet(filters, column);
        tags[column] = sql(q.sql, q.args);
      }
      /* Authors need json_each, which the oldest SQLite this app supports does
         not have. Worth offering where it works, not worth an error where it
         does not. */
      let authorTotal = 0;
      try {
        const q = buildAuthorFacet(filters, 40);
        tags.author = sql(q.sql, q.args);
        const c = buildAuthorCount(filters);
        authorTotal = sql(c.sql, c.args)[0]?.n ?? 0;
      } catch (e) { waiting(e); tags.author = []; }
      return { counts, tags, fandoms: tags.fandom, languages: tags.language, authorTotal };
    },

    work: (workId) => {
      const work = one(`SELECT w.*, ${FF_VISITS} AS ff_visits FROM works w WHERE work_id = ?`, [workId]);
      if (!work) throw new Error('no such work');
      const tags = {};
      for (const t of sql('SELECT kind, name FROM tags WHERE work_id = ? ORDER BY kind, name', [workId])) {
        (tags[t.kind] ??= []).push(t.name);
      }
      const progress = one(
        'SELECT chapter, offset, chapters_read, opened_at, completed_before FROM reading WHERE work_id = ?', [workId]);
      return {
        ...work,
        at_chapter: progress?.chapter ?? null,
        chapters_read: progress?.chapters_read ?? 0,
        offset: progress?.offset ?? 0,
        opened_at: progress?.opened_at ?? null,
        completed_before: progress?.completed_before ?? 0,
        tags,
        end_notes_html: work.end_notes_html ? sanitiseHtml(work.end_notes_html) : null,
        chapters: sql('SELECT number, title, words FROM chapters WHERE work_id = ? ORDER BY number', [workId]),
        versions: one('SELECT count(*) AS n FROM chapter_versions WHERE work_id = ?', [workId])?.n ?? 0,
      };
    },

    chapter: (workId, number) => {
      const row = one('SELECT number, title, html FROM chapters WHERE work_id = ? AND number = ?',
        [workId, number]);
      if (!row) throw new Error('no such chapter');
      const work = one('SELECT skin_css FROM works WHERE work_id = ?', [workId]);
      const images = new Map(
        sql("SELECT url, sha256, fetched_at FROM images WHERE work_id = ? AND status = 'stored' AND length(sha256) = 64 AND length(bytes) > 0", [workId])
          .map((i) => [i.url, `/img/${i.sha256}?saved=${encodeURIComponent(i.fetched_at || "")}`])
      );
      return { number: row.number, title: row.title,
        ...renderChapter(row, { skinCss: work?.skin_css ?? null, images }) };
    },

    /**
     * Earlier copies of a work's chapters.
     *
     * The archive is a living thing: authors revise, rewrite and sometimes
     * delete. Every replaced chapter has been kept since versioning went in, and
     * until now there was no way to look at one — the whole point of keeping
     * them is being able to read what you read the first time.
     *
     * The text itself is left behind here; a list of what exists should not
     * carry a megabyte of prose.
     */
    versions: (workId) => sql(`
      SELECT id, number, title, words, reason, archived_at
        FROM chapter_versions WHERE work_id = ?
       ORDER BY archived_at DESC, number ASC`, [workId]),

    version: (workId, id) => {
      const row = one(`SELECT id, number, title, html, words, reason, archived_at
                         FROM chapter_versions WHERE work_id = ? AND id = ?`, [workId, id]);
      if (!row) throw new Error('no such version');
      const work = one('SELECT title, skin_css FROM works WHERE work_id = ?', [workId]);
      const images = new Map(
        sql("SELECT url, sha256, fetched_at FROM images WHERE work_id = ? AND status = 'stored' AND length(sha256) = 64 AND length(bytes) > 0", [workId])
          .map((i) => [i.url, `/img/${i.sha256}?saved=${encodeURIComponent(i.fetched_at || "")}`])
      );
      return {
        ...row,
        workTitle: work?.title ?? '',
        ...renderChapter(row, { skinCss: work?.skin_css ?? null, images }),
      };
    },

    search: (query, scope, options) => {
      const started = Date.now();
      try {
        return { ...search(sql, query, scope, options), ms: Date.now() - started };
      } catch (e) {
        waiting(e);
        // a half-typed query is the reader typing, not a fault
        return { error: e.message, hits: [], works: [], tags: [] };
      }
    },
  };

  /** The answer to a read, or undefined when the path is not one of these. */
  function read(path) {
    const url = new URL(path, 'https://local/');
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);

    if (p === '/api/works') return LOCAL['/api/works'](q);
    if (p === '/api/facets') return LOCAL.facets(q);
    if (p === '/api/facet-search') return LOCAL.facetSearch(q);
    if (p === '/api/home') return LOCAL.home();
    if (p === '/api/surprise') return LOCAL.surprise();

    let m;
    if ((m = p.match(new RegExp(`^/api/works/${WORK}$`)))) return LOCAL.work(m[1]);
    if ((m = p.match(new RegExp(`^/api/works/${WORK}/chapters/(\\d+)$`)))) return LOCAL.chapter(m[1], Number(m[2]));
    if ((m = p.match(new RegExp(`^/api/works/${WORK}/versions$`)))) return { versions: LOCAL.versions(m[1]) };
    if ((m = p.match(new RegExp(`^/api/works/${WORK}/versions/(\\d+)$`)))) return LOCAL.version(m[1], Number(m[2]));
    if (p === '/api/search') {
      return LOCAL.search(q.q ?? '', q.scope || 'text',
        { limit: q.limit, workId: q.workId, filters: q });
    }
    return undefined;
  }

  return { ...LOCAL, read };
}
