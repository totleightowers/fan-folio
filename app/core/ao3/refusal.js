/**
 * What the archive said when it turned something down.
 *
 * Kudos, a bookmark or a comment that the archive refuses comes back as a page
 * with the reason in an error box. Three callers asked for that reason by a
 * name that was never defined, so every refusal surfaced as "refusal is not
 * defined" instead — the one message guaranteed to say nothing about what
 * went wrong.
 */
const ERROR_BOX = /<(div|p|li|ul)\b[^>]*\bclass="[^"]*\berror\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/i;

export function refusal(res, fallback) {
  const said = ERROR_BOX.exec(String(res?.body ?? ''))?.[2] ?? '';
  // Text only, and not much of it: this goes into a toast.
  let text = said;
  let previous;
  do { previous = text; text = text.replace(/<[^>]*>/g, ' '); } while (text !== previous);
  text = text.replace(/[<>]/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’')
    .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  if (text.length > 160) text = text.slice(0, 157).trimEnd() + '…';
  if (text) return `${fallback}: ${text}`;
  const status = Number(res?.status);
  return Number.isFinite(status) && status ? `${fallback} (${status})` : fallback;
}
