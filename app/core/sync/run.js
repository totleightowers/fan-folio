/**
 * Keeping the library current, from inside the app.
 *
 * Until now this only existed as a script on a laptop: the app could add one
 * work from a link and nothing else, so a bookmark made on the archive stayed
 * invisible until somebody ran a tool and moved a database across.
 *
 * Everything the archive is asked for goes through here so there is one place
 * that decides how often. That matters more than anything else in this file —
 * an app that walks somebody's bookmarks impatiently gets their account
 * limited, and they will not know why.
 */

/** Roughly two a minute, spread out. Matches what the walker settled on. */
export const MIN_GAP_MS = 28_000;

/**
 * Gaps drawn from an exponential distribution rather than a fixed wait.
 *
 * A request exactly every 28 seconds is a metronome, and a metronome is the
 * easiest thing in the world to notice. The mean is what matters; the spacing
 * should not be predictable.
 */
export function nextGap(minGap = MIN_GAP_MS, random = Math.random) {
  const spread = -Math.log(1 - random()) * minGap;
  return Math.round(Math.min(Math.max(spread, minGap * 0.45), minGap * 2.5));
}

/**
 * Walk the bookmark pages until they stop telling us anything new.
 *
 * Bookmarks are listed newest first, so once a whole page is already held
 * there is nothing older worth walking to — the rest of the list was collected
 * on a previous run. A full re-walk is 86 pages; this is usually one.
 */
export async function findNewBookmarks({
  fetchPage,
  isHeld,
  maxPages = 40,
  onProgress = () => {},
  shouldStop = () => false,
}) {
  const found = [];
  let totalPages = null;

  for (let page = 1; page <= maxPages; page++) {
    if (shouldStop()) break;
    const { works, pagination } = await fetchPage(page);
    /* parsePagination reports { current, total }. Reading a totalPages that
       never existed left the walk with no idea where the end was, and only a
       hand-written fake made it look right. */
    totalPages = pagination?.total ?? totalPages;

    const fresh = works.filter((w) => w.workId && !isHeld(w.workId));
    for (const w of fresh) found.push(w.workId);
    onProgress({ phase: 'listing', page, totalPages, found: found.length });

    // a page with nothing new on it means the rest was gathered before
    if (!fresh.length) break;
    if (totalPages && page >= totalPages) break;
  }

  return { workIds: found, pagesWalked: Math.min(maxPages, totalPages ?? maxPages) };
}

/**
 * Fetch a list of works, one at a time, waiting between each.
 *
 * A work that cannot be fetched is recorded and stepped over: a bookmark
 * outlives the work it points at, and one deleted story should not end a sync.
 */
export async function fetchWorks({
  workIds,
  fetchWork,
  wait,
  onProgress = () => {},
  shouldStop = () => false,
}) {
  const added = [];
  const failed = [];

  for (let i = 0; i < workIds.length; i++) {
    if (shouldStop()) break;
    if (i > 0) await wait(nextGap());

    const workId = workIds[i];
    try {
      added.push(await fetchWork(workId));
    } catch (e) {
      failed.push({ workId, reason: String(e.message ?? e) });
    }
    onProgress({ phase: 'fetching', done: i + 1, total: workIds.length, added: added.length });
  }

  return { added, failed };
}

/** Twenty to a listing page, which is what decides how many pages a walk is. */
export const PER_LISTING_PAGE = 20;

/**
 * How much work an author's listing represents, before any of it is done.
 *
 * A listing page describes twenty works for one request, so walking a prolific
 * author is cheap per work and expensive in total. Knowing the size first is
 * what lets a small author open instantly and a large one ask permission.
 */
export function listingCost(totalPages, perPage = PER_LISTING_PAGE) {
  const pages = Math.max(1, Number(totalPages) || 1);
  return { pages, works: pages * perPage, minutes: Math.ceil((pages * MIN_GAP_MS) / 60_000) };
}

/**
 * Whether to walk the rest without being asked.
 *
 * Under the threshold the whole listing is a handful of requests and waiting
 * for a tap only adds a tap. Over it, the reader is committing minutes of
 * their time and the archive's patience, and should say so first.
 */
export function shouldWalkWholeListing(totalPages, threshold = 200) {
  return listingCost(totalPages).works < threshold;
}

/**
 * Walk every page of a listing, collecting what it describes.
 *
 * Unlike the bookmark sync this does not stop early at familiar works: an
 * author page is asked for in order to see all of it, and a work already held
 * still belongs in the list.
 */
export async function walkListing({
  fetchPage,
  maxPages = 200,
  onProgress = () => {},
  shouldStop = () => false,
  wait,
}) {
  const works = [];
  let totalPages = null;

  for (let page = 1; page <= maxPages; page++) {
    if (shouldStop()) break;
    if (page > 1 && wait) await wait(nextGap());

    const { works: found, pagination } = await fetchPage(page);
    totalPages = pagination?.total ?? totalPages;
    works.push(...found.filter((w) => w.workId));
    onProgress({ page, totalPages, works: works.length });

    if (!found.length) break;
    if (totalPages && page >= totalPages) break;
  }

  return { works, totalPages: totalPages ?? 1 };
}

/**
 * Is this worth trying again?
 *
 * A work that was deleted will be deleted next time too, and asking again is
 * rude and pointless. A 500 is the archive having a bad moment; giving up on
 * it and calling the work "unavailable" writes off something that was
 * probably fine a minute later.
 */
export function isTransient(reason) {
  const text = String(reason ?? '');
  /*
   * Being told to slow down is not being told no.
   *
   * 429 is the archive rate-limiting, which is the most retriable thing there
   * is — and it was landing in the blanket 4xx rule below and being written
   * off as a work that could not be had. During a long download that is the
   * worst possible reading of it: the moment the archive starts throttling,
   * every work in flight is permanently skipped, and the queue reports them
   * as unavailable. 408 and 425 are the same kind of answer.
   */
  if (/answered (429|408|425)/i.test(text)) return true;
  if (/rate limit|too many requests|retry.?after|slow down/i.test(text)) return true;

  if (/answered 4\d\d/i.test(text)) return false;          // it answered, and said no
  if (/deleted|does not exist|no chapters found/i.test(text)) return false;

  /*
   * Never getting there is always worth trying again.
   *
   * These are the ways a phone fails to reach a host, and every one of them
   * is a moment rather than a verdict: a tunnel, a handover between masts, a
   * network that has not finished coming up. They were all being read as the
   * work being unavailable, so a few seconds without signal permanently gave
   * up on whatever happened to be in flight — and the reader was told the
   * work had been skipped, which was not true and not actionable.
   *
   * Named rather than matched loosely, because "unavailable" has to keep
   * meaning something: a work that is genuinely gone still stops here.
   */
  return /answered 5\d\d|could not reach|timed out|timeout|network|failed to fetch/i.test(text)
    || /unable to resolve host|no address associated|unknownhost|enotfound|eai_again/i.test(text)
    || /connection (reset|refused|abort|closed)|econnreset|econnrefused|econnaborted/i.test(text)
    || /unexpected end of stream|broken pipe|software caused connection abort/i.test(text)
    || /sslexception|handshake|socketexception|sockettimeout|protocol error/i.test(text);
}

/** How long to leave it before trying again: longer each time. */
export function retryDelay(attempt, base = MIN_GAP_MS) {
  return Math.round(base * Math.min(2 ** attempt, 8));
}
