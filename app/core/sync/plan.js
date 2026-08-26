/**
 * Decide what actually needs fetching.
 *
 * This is where the request budget is won or lost. Given what is already held
 * and what the listings say exists, most works resolve to "do nothing" — and
 * a work that resolves to "do nothing" costs zero requests instead of one.
 *
 * Pure: no fetching, no database, no clock beyond what is passed in. Every
 * decision here is testable, which matters because a wrong "skip" silently
 * leaves a gap in the archive and a wrong "fetch" costs an hour.
 */

/** AO3's listing epoch → the YYYY-MM-DD the EPUB preface records. */
export function epochToDate(epoch) {
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

/**
 * The best "when was this last changed" a stored work can offer.
 *
 * Only ~24% of the library records an updated or completed date, so the date
 * the file itself was written is the primary signal — it is when AO3's version
 * was captured. The work's own dates are fallbacks for records that lack it.
 */
export function heldAsOf(held) {
  // When the copy was taken beats anything the work says about itself: it
  // answers "is our copy current?" directly, where published answers only
  // "when did this first appear?" and flags every revised work as stale.
  return held?.downloadedAt ?? held?.updated ?? held?.completed ?? held?.published ?? null;
}

export const ACTIONS = {
  FETCH: 'fetch',       // not held at all
  REFETCH: 'refetch',   // held, but AO3 says it changed
  SKIN: 'skin',         // held and current, but needs its work skin
  SKIP: 'skip',         // held, current, nothing wanted
};

/**
 * @param listed  Map/object of workId → listing blurb (needs updatedAt)
 * @param library Map/object of workId → held record (from the EPUB index)
 */
export function planSync(listed, library, { wantSkins = true } = {}) {
  const listedEntries = listed instanceof Map ? [...listed] : Object.entries(listed ?? {});
  const held = library instanceof Map ? library : new Map(Object.entries(library ?? {}));

  const actions = { fetch: [], refetch: [], skin: [], skip: [] };
  const reasons = new Map();

  for (const [workId, blurb] of listedEntries) {
    const have = held.get(workId);
    if (!have) {
      actions.fetch.push(workId);
      reasons.set(workId, 'not held');
      continue;
    }

    const listedDate = epochToDate(blurb?.updatedAt);
    const ourDate = heldAsOf(have);
    // no date on either side means no evidence of change — and guessing
    // "changed" here would refetch the whole library for nothing
    if (listedDate && ourDate && listedDate > ourDate) {
      actions.refetch.push(workId);
      reasons.set(workId, `AO3 ${listedDate} > held ${ourDate}`);
      continue;
    }

    if (wantSkins && have.needsSkin && !have.skinCss) {
      actions.skin.push(workId);
      reasons.set(workId, 'custom markup with no skin stored');
      continue;
    }

    actions.skip.push(workId);
    reasons.set(workId, 'held and current');
  }

  const requests = actions.fetch.length + actions.refetch.length + actions.skin.length;
  return {
    actions,
    reasons,
    counts: {
      listed: listedEntries.length,
      fetch: actions.fetch.length,
      refetch: actions.refetch.length,
      skin: actions.skin.length,
      skip: actions.skip.length,
      requests,
    },
  };
}

/** Wall-clock estimate at a given mean gap, so a plan can be judged before it runs. */
export function estimate(requests, meanGapMs = 29000) {
  const ms = requests * meanGapMs;
  const hours = ms / 3_600_000;
  return {
    requests,
    hours: Number(hours.toFixed(1)),
    human: hours < 1 ? `${Math.round(ms / 60000)} min` : `${hours.toFixed(1)} hours`,
  };
}

/**
 * Merge the two listings into one set of works to consider.
 *
 * History and bookmarks overlap heavily — you bookmark what you read — and a
 * work in both must be fetched once, not twice. Membership is recorded so the
 * reader can still filter by "bookmarked" or "in history".
 */
export function mergeListings({ bookmarks = {}, history = {} } = {}) {
  const merged = new Map();
  const add = (works, flag) => {
    for (const [workId, blurb] of Object.entries(works ?? {})) {
      const prev = merged.get(workId);
      merged.set(workId, { ...prev, ...blurb, ...(prev ?? {}), [flag]: true,
        // keep whichever epoch is newer; the two pages can disagree by a hit
        updatedAt: Math.max(prev?.updatedAt ?? 0, blurb?.updatedAt ?? 0) || null });
    }
  };
  add(bookmarks, 'inBookmarks');
  add(history, 'inHistory');
  return merged;
}
