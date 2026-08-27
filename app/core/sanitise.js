/**
 * Parser-based sanitising.
 *
 * The previous sanitiser removed patterns from a string, and a real bypass was
 * found in it: a nested tag such as scr + script + ipt holds no complete tag
 * until the inner one is removed, at which point the outer halves join into a
 * working one. Looping to a fixed point fixed that case, but the approach
 * stays fragile: every fix is another pattern, and the next malformed shape is
 * somebody else's to invent.
 *
 * This works the other way round. The markup is tokenised once and nothing
 * survives unless it is on the allowlist, so an unfamiliar construction fails
 * closed. The output is re-serialised from tokens built here, so a browser
 * cannot be led to a different tree than the one this function inspected.
 */

/** Elements a work may use. Everything structural, nothing that acts. */
const ALLOWED = new Set([
  'p', 'br', 'hr', 'em', 'i', 'strong', 'b', 'u', 's', 'strike', 'del', 'ins',
  'sub', 'sup', 'small', 'big', 'span', 'div', 'section', 'article', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'q', 'cite', 'pre', 'code',
  'kbd', 'samp', 'var', 'abbr', 'dfn', 'address', 'ul', 'ol', 'li', 'dl', 'dt',
  'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'colgroup', 'col', 'figure', 'figcaption', 'img', 'a', 'ruby', 'rt', 'rp',
  'details', 'summary', 'mark', 'time', 'wbr', 'center', 'font',
]);

/** Elements with no closing tag. */
const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr']);

/** Attributes allowed on any element. */
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'dir', 'lang', 'style', 'align']);

/** Attributes allowed only on particular elements. */
const ATTRS = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height', 'data-remote-src', 'data-stored']),
  td: new Set(['colspan', 'rowspan', 'headers', 'scope']),
  th: new Set(['colspan', 'rowspan', 'headers', 'scope', 'abbr']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  ol: new Set(['start', 'type', 'reversed']),
  li: new Set(['value']),
  time: new Set(['datetime']),
  details: new Set(['open']),
  font: new Set(['color', 'face', 'size']),
};

/**
 * A URL is refused by its scheme, not by requiring one.
 *
 * Relative references — "img1.jpg", the packaged images inside every EPUB —
 * carry no scheme at all and must survive; requiring one dropped every
 * packaged image in the library. So the leading scheme is read, and only a
 * scheme we do not trust is a reason to refuse.
 */
const LEADING_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

/** Characters a browser ignores inside a scheme, and an attacker hides one in. */
const INVISIBLE = /[\u0000-\u0020\u00a0\u2000-\u200f\u2028-\u202f\ufeff]/g;

/**
 * Declarations that let content leave its box or cover the app's own UI.
 * position:fixed across the screen is how a work skin stops being a work skin
 * and starts being a phishing overlay.
 */
const UNSAFE_CSS = /(position\s*:\s*(fixed|sticky))|(z-index\s*:\s*\d{3,})|(@import)|(expression\s*\()|(behaviou?r\s*:)|(-moz-binding)|(url\s*\(\s*['"]?\s*(javascript|data):)/gi;

const ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/*
 * An ampersand that already begins an entity is left alone. Escaping it again
 * turns &amp; into &amp;amp;, which the reader sees as literal "&amp;" — and
 * turns a stored image URL into one that no longer matches its record.
 */
const BARE_AMP = /&(?!#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]{1,30};)/gi;
const escapeText = (s) => String(s).replace(BARE_AMP, '&amp;').replace(/[<>]/g, (c) => ESCAPE[c]);
const escapeAttr = (s) => String(s).replace(BARE_AMP, '&amp;').replace(/[<>"]/g, (c) => ESCAPE[c]);

/**
 * Where a start tag actually ends.
 *
 * Not the next '>': in HTML a '>' inside a quoted attribute value does not
 * close the tag, so `<a href="data:text/html,<script>">` is one tag as far as
 * a browser is concerned. Splitting at the first '>' would leave this function
 * reading a different document from the one the browser assembles, and the
 * whole point of parsing is that the two agree.
 */
function findTagEnd(input, from) {
  let quote = '';
  for (let i = from; i < input.length; i++) {
    const ch = input[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

/** Attributes out of a start tag, without backtracking on malformed input. */
function readAttributes(source) {
  const attrs = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let m;
  while ((m = re.exec(source))) {
    attrs.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
  }
  return attrs;
}

function keepAttribute(tag, name, value) {
  // an on* handler is the whole reason an allowlist exists
  if (name.startsWith('on')) return null;
  if (!(GLOBAL_ATTRS.has(name) || ATTRS[tag]?.has(name))) return null;

  if (name === 'href' || name === 'src') {
    /* Invisible characters are stripped before the scheme is checked. A tab
       inside "java(tab)script:" means the prefix test passes and the browser
       still runs it — the check has to see what the browser will see. */
    const url = value.trim().replace(INVISIBLE, '');
    if (name === 'src' && !url) return '';
    const scheme = LEADING_SCHEME.exec(url);
    if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return null;
    return url;
  }
  if (name === 'style') {
    const cleaned = value.replace(UNSAFE_CSS, '');
    return cleaned.trim() ? cleaned : null;
  }
  if (name === 'target') return '_blank';
  return value;
}

/**
 * Sanitise a fragment of author-written HTML.
 *
 * Comments, doctypes, processing instructions, unknown elements and every
 * attribute not on the allowlist are dropped.
 */
export function sanitiseFragment(html) {
  const input = String(html ?? '');
  const out = [];
  const open = [];
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt < 0) { out.push(escapeText(input.slice(i))); break; }
    if (lt > i) out.push(escapeText(input.slice(i, lt)));

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end < 0 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith('<!', lt) || input.startsWith('<?', lt)) {
      const end = input.indexOf('>', lt);
      i = end < 0 ? input.length : end + 1;
      continue;
    }

    const gt = findTagEnd(input, lt + 1);
    if (gt < 0) { i = input.length; break; }
    const raw = input.slice(lt + 1, gt);
    i = gt + 1;

    const closing = raw.startsWith('/');
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(raw);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();

    if (closing) {
      if (!ALLOWED.has(tag)) continue;
      const at = open.lastIndexOf(tag);
      if (at < 0) continue;
      for (let d = open.length - 1; d >= at; d--) out.push('</' + open[d] + '>');
      open.length = at;
      continue;
    }

    if (!ALLOWED.has(tag)) {
      /* Script and style carry their content as text, so dropping the tag
         alone would spill the source into the page. Skip to the matching end. */
      if (tag === 'script' || tag === 'style' || tag === 'title' || tag === 'textarea') {
        const end = input.toLowerCase().indexOf('</' + tag, i);
        i = end < 0 ? input.length : (input.indexOf('>', end) + 1 || input.length);
      }
      continue;
    }

    const kept = [];
    for (const [name, value] of readAttributes(raw.slice(nameMatch[0].length))) {
      const safe = keepAttribute(tag, name, value);
      if (safe !== null) kept.push(name + '="' + escapeAttr(safe) + '"');
    }
    // a link opening elsewhere must not hand the opener over with it
    if (tag === 'a' && kept.some((a) => a.startsWith('target='))) {
      kept.push('rel="noopener noreferrer"');
    }

    out.push('<' + tag + (kept.length ? ' ' + kept.join(' ') : '') + '>');
    if (!VOID.has(tag) && !/\/\s*$/.test(raw)) open.push(tag);
  }

  for (let d = open.length - 1; d >= 0; d--) out.push('</' + open[d] + '>');
  return out.join('');
}

/** Author-written CSS, stripped of what can escape the work. */
export function sanitiseCss(css) {
  return String(css ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(UNSAFE_CSS, '');
}
