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
 * Links get shared in every shape: a chapter deep-link, a URL with tracking
 * parameters, a bare id, the mobile host, sometimes with a trailing full stop
 * from the end of a sentence. All of them name the same work.
 *
 * Returns null rather than guessing when there is no work id, so a mistyped
 * link fails immediately instead of fetching something arbitrary.
 */
export function workIdFrom(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return text;

  // an id must follow /works/ — /collections/x/works/ still names a work,
  // but /tags/.../works is a listing and names none
  const m = text.match(/\/works\/(\d+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

export function workUrl(workId) {
  return `${ORIGIN}/works/${Number(workId)}`;
}
