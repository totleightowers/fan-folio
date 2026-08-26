/**
 * Keeping what a work used to say.
 *
 * Authors revise. They fix typos, rewrite endings, change a work skin, and
 * occasionally cut whole scenes. A sync that overwrites silently means the
 * version you read is gone, and there is no way to find out what changed —
 * which is exactly the failure this archive exists to prevent.
 *
 * So content is compared before it is replaced, and anything superseded is
 * kept. Comparison is by hash of the *content*, not of the markup wrapper:
 * refetching an unchanged chapter must not manufacture a version.
 */

/**
 * A content hash, in whichever runtime this is called from.
 *
 * SHA-256 via WebCrypto in the app, node:crypto in tooling. Async because
 * WebCrypto is, and a versioning decision is never on a hot path.
 */
export async function hashContent(value) {
  const text = String(value ?? '');
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Markup differences that are not content differences.
 *
 * The same chapter fetched twice can differ byte for byte — AO3 stamps kudos
 * counts and CSRF tokens into pages, and whitespace shifts between renders.
 * Hashing that raw would archive a "new version" on every single sync and bury
 * the real edits in noise. Normalising first means a version is recorded when
 * the words or the structure actually changed.
 */
export function normaliseForComparison(html) {
  let text = String(html ?? '');
  // nested comment markers reassemble the same way tags do; each pass that
  // changes the string shortens it, so this settles
  let previous;
  do {
    previous = text;
    text = text.replace(/<!--[\s\S]*?-->/g, '');
  } while (text !== previous);
  return text
    // AO3 mints a fresh CSRF token per request; it is not part of the work
    .replace(/name="authenticity_token"[^>]*value="[^"]*"/gi, 'name="authenticity_token"')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
}

export const CHANGE = {
  CONTENT: 'content',   // the words changed
  LAYOUT: 'layout',     // the work skin changed
  NEW: 'new',           // a chapter that did not exist before
  NONE: 'none',
};

/**
 * What changed between what is held and what has just been fetched.
 *
 * Pure, so the decision can be tested without a database: given two sets of
 * chapters and two skins, say precisely which chapters need archiving and why.
 */
export async function planVersioning(held, incoming) {
  const heldByNumber = new Map((held.chapters ?? []).map((c) => [Number(c.number), c]));
  const changes = [];

  for (const chapter of incoming.chapters ?? []) {
    const number = Number(chapter.number);
    const previous = heldByNumber.get(number);
    if (!previous) { changes.push({ number, change: CHANGE.NEW }); continue; }

    const [before, after] = await Promise.all([
      hashContent(normaliseForComparison(previous.html)),
      hashContent(normaliseForComparison(chapter.html)),
    ]);
    if (before !== after) {
      changes.push({ number, change: CHANGE.CONTENT, previousHash: before, hash: after, previous });
    }
  }

  // a chapter that has disappeared is itself a change worth keeping the old
  // copy for — authors do delete chapters, and orphaning it loses it
  for (const [number, previous] of heldByNumber) {
    if (!(incoming.chapters ?? []).some((c) => Number(c.number) === number)) {
      changes.push({ number, change: CHANGE.CONTENT, removed: true, previous });
    }
  }

  let skinChange = null;
  const heldSkin = held.skinCss ?? '';
  const newSkin = incoming.skinCss ?? '';
  if (heldSkin !== newSkin && (heldSkin || newSkin)) {
    const [before, after] = await Promise.all([
      hashContent(normaliseForComparison(heldSkin)),
      hashContent(normaliseForComparison(newSkin)),
    ]);
    if (before !== after) skinChange = { change: CHANGE.LAYOUT, previousHash: before, hash: after };
  }

  return {
    changes,
    skinChange,
    changed: changes.length > 0 || skinChange !== null,
  };
}
