/**
 * A search snippet, as pieces of text.
 *
 * SQLite wraps each match in <mark> … </mark> and returns the rest of the
 * passage exactly as it was indexed. What was indexed is plain text with its
 * entities decoded, so a chapter that *discussed* markup — "&lt;img onerror=…&gt;"
 * in an author's note — comes back holding real angle brackets. Handing that
 * string to innerHTML runs it. The delimiters are the only markup we put
 * there, so they are the only markup read back out; everything between them
 * is text and is shown as text.
 */
export function snippetParts(snippet) {
  const parts = [];
  const text = String(snippet ?? '');
  const re = /<mark>([\s\S]*?)<\/mark>/g;
  let at = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index), mark: false });
    if (m[1]) parts.push({ text: m[1], mark: true });
    at = re.lastIndex;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}
