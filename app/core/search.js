/**
 * Relevance ranking for FTS4.
 *
 * FTS5 has bm25() built in; FTS4 does not, and Android's SQLite has shipped
 * FTS4 for years while FTS5 arrived only recently — so the index is FTS4 and
 * the ranking is computed here. Doing it in shared JavaScript rather than in
 * SQL means the dev server and the phone rank identically, which matters: a
 * search that returns different orders in the two places is a search you
 * cannot reason about.
 *
 * matchinfo('pcnalx') lays out 32-bit integers as:
 *   p  number of phrases in the query
 *   c  number of columns in the table
 *   n  number of rows in the table
 *   a  average length, one per column
 *   l  length of this row, one per column
 *   x  three values per (phrase, column): hits here, hits everywhere, rows hit
 */

const K1 = 1.2;   // term-frequency saturation, SQLite's own documented default
const B = 0.75;   // length normalisation

/** Base64 → bytes, for blobs that crossed the native bridge as JSON strings. */
function decodeBase64(text) {
  if (typeof atob === 'function') {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/**
 * Little-endian 32-bit words out of the matchinfo blob.
 *
 * Arrives as bytes from node's SQLite and as a base64 string from the Android
 * bridge, because JSON has no way to carry a blob. Both are accepted here so
 * nothing above this function has to know which runtime it is in.
 */
export function readMatchinfo(blob) {
  if (typeof blob === 'string') return readMatchinfo(decodeBase64(blob));
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob ?? []);
  const out = new Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < out.length; i++) {
    out[i] = bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16)
      | (bytes[i * 4 + 3] << 24);
  }
  return out;
}

/**
 * A BM25 score for one row. Higher is better.
 *
 * Returns 0 for anything unparseable rather than throwing: a ranking failure
 * should degrade the order of results, never lose them.
 */
export function bm25(blob) {
  const m = readMatchinfo(blob);
  if (m.length < 3) return 0;

  const phrases = m[0];
  const columns = m[1];
  const totalRows = m[2];
  if (!phrases || !columns || !totalRows) return 0;

  const avgAt = 3;
  const lenAt = avgAt + columns;
  const xAt = lenAt + columns;
  if (m.length < xAt + phrases * columns * 3) return 0;

  let score = 0;
  for (let phrase = 0; phrase < phrases; phrase++) {
    for (let col = 0; col < columns; col++) {
      const base = xAt + 3 * (col + phrase * columns);
      const hitsHere = m[base];
      const rowsWithPhrase = m[base + 2];
      if (!hitsHere) continue;

      const avgLength = m[avgAt + col] || 1;
      const length = m[lenAt + col] || 1;

      // the usual BM25 idf, floored at zero so a term present in every row
      // cannot drag a score negative
      const idf = Math.max(0,
        Math.log((totalRows - rowsWithPhrase + 0.5) / (rowsWithPhrase + 0.5)));
      const norm = K1 * (1 - B + (B * length) / avgLength);
      score += idf * ((hitsHere * (K1 + 1)) / (hitsHere + norm));
    }
  }
  return score;
}

/** Rank rows carrying a `matchinfo` field, best first, and trim to `limit`. */
export function rank(rows, limit = 40) {
  return rows
    .map((row) => ({ ...row, score: bm25(row.matchinfo) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ matchinfo, ...rest }) => rest);   // the blob is working state, not output
}

/**
 * How many rows to score before trimming.
 *
 * Ranking happens after SQLite has returned rows in rowid order, so the
 * candidate pool has to be wider than the answer or the best match for a
 * common word may never be considered.
 */
export const CANDIDATES = 600;
