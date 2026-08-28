/**
 * Every AO3 URL this app asks for, in one place.
 *
 * Centralised so the crawler cannot invent an endpoint by string-concatenation
 * halfway through a run, and so the politeness rules have a single surface to
 * cover. Nothing here performs a request.
 */

export const ORIGIN = 'https://archiveofourown.org';
export const DOWNLOAD_ORIGIN = 'https://download.archiveofourown.org';

/** AO3 puts 20 works on a listing page and offers no way to ask for more. */
export const PER_PAGE = 20;

const enc = encodeURIComponent;

/**
 * The whole work, all chapters, in one response — and the only place the
 * author's work skin appears. This is the fetch the archive is built on.
 */
export function workPage(workId, { comments = false } = {}) {
  const params = new URLSearchParams({ view_full_work: 'true', view_adult: 'true' });
  if (comments) params.set('show_comments', 'true');
  return `${ORIGIN}/works/${Number(workId)}?${params}`;
}

/** Lighter and cacheable, but carries no work skin. Kept for text-only refetches. */
export function workDownload(workId, slug = 'work') {
  return `${DOWNLOAD_ORIGIN}/downloads/${Number(workId)}/${enc(slug)}.html`;
}

/** Reading history. Login required, and it is per-user, so the name matters. */
export function readings(user, page = 1) {
  return `${ORIGIN}/users/${enc(user)}/readings?page=${Number(page)}`;
}

/**
 * Where a byline points.
 *
 * The archive writes a byline as "Pseud (Username)" whenever the two differ,
 * and roughly a quarter of a library is that shape. Handing that whole string
 * over as a username asks for /users/Anna%20(pineconepickers) and is answered
 * with a 404 — which is what every one of those authors did.
 *
 * The link the archive puts on its own byline is the pseud's:
 *
 *   <a rel="author" href="/users/pineconepickers/pseuds/Anna">Anna (pineconepickers)</a>
 *
 * so that is the shape built here, and a bare name is a pseud of the same
 * name. Going by pseud rather than account is not only what the byline means,
 * it is the only safe reading of one: orphaned works are posted under
 * orphan_account, whose account page holds over a million works. An app that
 * resolved a byline to its account would answer a tap on one orphaned story
 * by trying to download the entire orphanage.
 */
export function authorPath(byline) {
  const name = String(byline ?? '').trim();
  const paren = /^(.*?)\s*\(([^()]+)\)$/.exec(name);
  const pseud = paren ? paren[1].trim() : name;
  const user = paren ? paren[2].trim() : name;
  return `/users/${enc(user)}/pseuds/${enc(pseud)}`;
}

/** Works and bookmarks are the archive's own name for these two tabs. */
export function authorProfile(byline) {
  return `${ORIGIN}${authorPath(byline)}`;
}
export function authorWorks(byline, page = 1) {
  return `${ORIGIN}${authorPath(byline)}/works?page=${Number(page)}`;
}
export function authorBookmarks(byline, page = 1) {
  return `${ORIGIN}${authorPath(byline)}/bookmarks?page=${Number(page)}`;
}

/**
 * Orphaning is the archive's way of keeping a work and losing its author, and
 * it means what it says: the pseud page 404s even though the byline links to
 * it. There is no catalogue behind these names, so there is nothing to walk.
 */
export function isOrphan(byline) {
  const name = String(byline ?? '').trim();
  const paren = /^(.*?)\s*\(([^()]+)\)$/.exec(name);
  return (paren ? paren[2].trim() : name) === 'orphan_account';
}

/**
 * A person's own page, which states how much they have.
 *
 * The counts are on it — Works (89), Bookmarks (503) — so one request can say
 * there is nothing to do, where finding that out by walking is a page for
 * every twenty works.
 */
export function userProfile(user) {
  return `${ORIGIN}/users/${enc(user)}`;
}

/** Everything an author has posted, twenty to a page. */
export function userWorks(user, page = 1) {
  return `${ORIGIN}/users/${enc(user)}/works?page=${Number(page)}`;
}

export function bookmarks(user, page = 1) {
  return `${ORIGIN}/users/${enc(user)}/bookmarks?page=${Number(page)}`;
}

/** Marked-for-later lives on the readings page behind a filter. */
export function markedForLater(user, page = 1) {
  return `${ORIGIN}/users/${enc(user)}/readings?page=${Number(page)}&show=to-read`;
}

/**
 * The work id out of anything a person is likely to paste.
 *
 * Links get shared in every shape: a chapter deep-link, a collection's copy, a
 * download link on another host, a URL with tracking parameters, a bare id.
 * All of them name the same work.
 *
 * This is linkTarget narrowed to the one question most callers ask. It used to
 * do its own matching, which meant two grammars for one set of URLs and a
 * download link that named a work the older one could not see.
 *
 * Returns null rather than guessing when there is no work id — a chapter id is
 * not a work id, and fetching /works/<chapter id> would quietly return a
 * different story instead of failing.
 */
export function workIdFrom(input) {
  const target = linkTarget(input);
  return target.kind === 'work' ? target.workId : null;
}


export function workUrl(workId) {
  return `${ORIGIN}/works/${Number(workId)}`;
}

/**
 * Every host the archive answers on.
 *
 * All of these were checked and every one redirects to archiveofourown.org, so
 * a link in any of these shapes is a link to the same work — and people paste
 * all of them. ao3.org in particular is what gets typed by hand and what fits
 * in a message.
 *
 * download.* is the host the archive's own download links use, so a shared
 * EPUB or HTML link arrives on it.
 */
export const AO3_HOSTS = new Set([
  'archiveofourown.org',
  'www.archiveofourown.org',
  'ao3.org',
  'www.ao3.org',
  'archiveofourown.com',
  'www.archiveofourown.com',
  'download.archiveofourown.org',
]);

/** Is this a link the archive would answer? Bare ids count: people paste those too. */
export function isAo3Link(input) {
  const text = String(input ?? '').trim();
  if (!text) return false;
  if (/^\d+$/.test(text)) return true;
  try {
    return AO3_HOSTS.has(new URL(text.startsWith('http') ? text : `https://${text}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** A chapter on its own. The archive redirects it to the work that owns it. */
export function chapterUrl(chapterId) {
  return `${ORIGIN}/chapters/${Number(chapterId)}`;
}

export function seriesPage(seriesId, page = 1) {
  return `${ORIGIN}/series/${Number(seriesId)}?page=${Number(page)}`;
}

/**
 * What a link actually points at.
 *
 * The archive names works in more shapes than one: inside a collection, as a
 * chapter deep-link, as a chapter on its own, as a download, as a series, as a
 * stub pointing somewhere off-site entirely. They are not interchangeable —
 * a chapter id is not a work id, and fetching /works/<chapter id> would
 * quietly return the wrong story rather than fail.
 *
 * Returns the kind as well as the id so the caller can tell the difference
 * between "this is work 123" and "the archive will have to tell us".
 *
 *   kind 'work'     workId is known and can be fetched now
 *   kind 'chapter'  only a chapter id; the archive must resolve it
 *   kind 'series'   many works; each must be fetched
 *   kind 'external' a stub for a work hosted somewhere else entirely
 *   kind 'unknown'  a real archive link, but not one that names a work
 */
export function linkTarget(input) {
  const text = String(input ?? '').trim();
  if (!text) return { kind: 'unknown' };
  if (/^\d+$/.test(text)) return { kind: 'work', workId: text };

  const path = pathOf(text);

  // /works/123, /works/123/chapters/456, /collections/x/works/123
  const work = path.match(/\/works\/(\d+)(?:[/?#]|$)/);
  if (work) return { kind: 'work', workId: work[1] };

  // the archive's own download links: /downloads/123/title.epub
  const download = path.match(/\/downloads\/(\d+)\//);
  if (download) return { kind: 'work', workId: download[1] };

  // a chapter with no work in the path; only the archive knows which work
  const chapter = path.match(/\/chapters\/(\d+)(?:[/?#]|$)/);
  if (chapter) return { kind: 'chapter', chapterId: chapter[1] };

  const series = path.match(/\/series\/(\d+)(?:[/?#]|$)/);
  if (series) return { kind: 'series', seriesId: series[1] };

  /* A stub for something hosted elsewhere — the archive holds the metadata
     but not the text, so there is nothing here to fetch. Recognised so it can
     be refused clearly rather than looking like a broken work link. */
  const external = path.match(/\/external_works\/(\d+)/);
  if (external) return { kind: 'external', externalId: external[1] };

  return { kind: 'unknown' };
}

/** The path part, whether or not the caller included a scheme or a host. */
function pathOf(text) {
  try {
    return new URL(text.startsWith('http') ? text : `https://${text}`).pathname;
  } catch {
    return text;      // a fragment of a path is still worth matching against
  }
}
