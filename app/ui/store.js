/** What the app remembers between sessions, in the browser's own store. */
/*
 * Read something back out of the store, in the shape it was asked for.
 *
 * This used to spread whatever it found into an object literal, which is
 * right for the settings — a stored theme laid over the defaults, so a key
 * added in a later version still has a value. Applied to a list it is
 * quietly wrong: spreading an array into an object gives {0:…, 1:…}, which
 * is not an array and not iterable, so the queue threw on the `for…of` that
 * restored it and every job saved when the app closed was lost on the way
 * back in. The fallback says which of the two was meant.
 */
export const load = (key, fallback) => {
  const empty = () => (Array.isArray(fallback) ? [...fallback] : { ...fallback });
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (stored == null) return empty();
    if (Array.isArray(fallback)) return Array.isArray(stored) ? stored : empty();
    return { ...fallback, ...stored };
  } catch { return empty(); }            // a corrupt or blocked store must not break reading
};
export const save = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};
