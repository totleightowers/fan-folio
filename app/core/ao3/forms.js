/**
 * Reading a form off a page, so the app submits what the archive asked for.
 *
 * Kudos, bookmarks and comments are all ordinary Rails forms. The alternative
 * to this is hardcoding their field names — `kudo[commentable_id]`,
 * `bookmark[pseud_id]`, and so on — which means guessing at a private API,
 * and being silently wrong the day any of them changes. A form already
 * carries its own action, method, CSRF token and defaults; reading them is
 * both more honest and more durable than knowing them.
 *
 * Nothing here performs a request.
 */

/**
 * Attributes of a single tag, as a plain object.
 *
 * Valueless attributes count. `selected` and `checked` are usually written
 * bare, and they are the two that decide what a form actually submits — a
 * parser that only sees name="value" pairs reads every option as unselected
 * and every box as unticked, then submits the wrong ones.
 */
function attrsOf(tag) {
  const out = {};
  const attr = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  // skip the tag name itself
  const body = tag.replace(/^<\s*[a-zA-Z][-\w:.]*/, '');
  for (const m of body.matchAll(attr)) {
    const value = m[2] ?? m[3] ?? m[4];
    out[m[1].toLowerCase()] = value === undefined ? '' : decodeEntities(value);
  }
  return out;
}

/**
 * The entities Rails escapes into attribute values.
 *
 * A CSRF token is base64 and routinely contains `+` and `/`; it is the `&`
 * that matters here, since a token submitted with a literal `&amp;` in it is
 * simply the wrong token and the archive rejects the whole request.
 */
function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The whole of one form element, counting nested forms out of caution. */
function formHtml(html, match) {
  const open = new RegExp(`<form\\b[^>]*${match}[^>]*>`, 'i');
  const start = html.search(open);
  if (start === -1) return null;
  const end = html.indexOf('</form>', start);
  return end === -1 ? html.slice(start) : html.slice(start, end);
}

/**
 * A form's action, method and every value it would submit untouched.
 *
 * `match` is a fragment matched inside the opening tag — an id or an action —
 * because the three forms wanted here are identified differently on the page.
 *
 * Unchecked boxes and unselected options are left out, exactly as a browser
 * would leave them out. Submitting them is how a private bookmark quietly
 * becomes a public one.
 */
export function parseForm(html, match) {
  const body = formHtml(String(html ?? ''), match);
  if (!body) return null;

  const open = body.match(/<form\b[^>]*>/i)?.[0] ?? '';
  const form = attrsOf(open);
  const fields = {};

  for (const tag of body.matchAll(/<input\b[^>]*>/gi)) {
    const a = attrsOf(tag[0]);
    if (!a.name) continue;
    const type = (a.type ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'file' || type === 'image') continue;
    // a browser sends a checkbox only when it is ticked, and so do we
    if ((type === 'checkbox' || type === 'radio') && !('checked' in a)) continue;
    fields[a.name] = a.value ?? (type === 'checkbox' ? 'on' : '');
  }

  for (const tag of body.matchAll(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/gi)) {
    const a = attrsOf(tag[0].match(/<textarea\b[^>]*>/i)[0]);
    if (a.name) fields[a.name] = decodeEntities(tag[1]);
  }

  for (const tag of body.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/gi)) {
    const a = attrsOf(tag[0].match(/<select\b[^>]*>/i)[0]);
    if (!a.name) continue;
    const options = [...tag[1].matchAll(/<option\b[^>]*>/gi)].map((o) => attrsOf(o[0]));
    // the selected one, or the first — which is what the browser would send
    const chosen = options.find((o) => 'selected' in o) ?? options[0];
    if (chosen) fields[a.name] = chosen.value ?? '';
  }

  return {
    action: form.action ?? '',
    method: (form.method ?? 'post').toLowerCase(),
    fields,
  };
}

/** The CSRF token, wherever it is on the page, for forms built by script. */
export function csrfToken(html) {
  const meta = String(html ?? '').match(
    /<meta\b[^>]*name=["']csrf-token["'][^>]*>/i);
  if (meta) return attrsOf(meta[0]).content ?? null;
  const input = String(html ?? '').match(
    /<input\b[^>]*name=["']authenticity_token["'][^>]*>/i);
  return input ? attrsOf(input[0]).value ?? null : null;
}

/** Form fields as a body the archive will accept. */
export function encodeForm(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}
