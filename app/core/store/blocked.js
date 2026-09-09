/**
 * Authors whose work is not wanted, and what that means for a work.
 *
 * Blocking is two promises: nothing of theirs is fetched again, and what is
 * already here stops being shown. The second one needs a rule about
 * collaborations, because a work has more than one author more often than
 * people expect — and blocking somebody should not cost you a work you like
 * that they happened to write half of.
 *
 * So: a work is hidden when *every* author of it is blocked. One name on a
 * work with two is a work you keep.
 */

/** Whatever the works table has in its authors column, as a list of names. */
export function authorsOf(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    /* Not JSON — an old import, or a column written by hand. A work whose
       authors cannot be read is a work nobody has blocked. */
    return [];
  }
}

/**
 * Is this work solely the work of blocked people?
 *
 * A work with no readable authors is never hidden. Hiding on the strength of
 * a field that failed to parse is how a library loses things silently, which
 * is the failure this app can least afford.
 */
export function isHidden(authors, blocked) {
  const names = authorsOf(authors);
  if (!names.length) return false;
  const set = blocked instanceof Set ? blocked : new Set(blocked ?? []);
  if (!set.size) return false;
  return names.every((name) => set.has(name));
}

/**
 * The works a name could possibly affect, matched the way the author filter
 * matches: the name as it appears quoted inside the JSON array, so "Anna"
 * does not match "Annabel". Blocking recomputes only these, not the library.
 */
export function worksByPattern(name) {
  const quoted = JSON.stringify(String(name)).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${quoted}%`;
}
