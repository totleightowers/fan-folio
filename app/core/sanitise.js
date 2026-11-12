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
 * What a browser makes of an attribute value before it acts on it.
 *
 * `href="&#106;avascript:…"` holds no scheme this file would refuse until the
 * entity is decoded, and the browser decodes it. Only the entities that can
 * spell a scheme or hide one are needed: numeric ones, the colon, and the
 * whitespace a URL parser throws away.
 */
const NAMED = { colon: ':', tab: '\t', newline: '\n', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function decodeEntities(value) {
  return String(value).replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]{2,7}));?/gi, (whole, hex, dec, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? whole;
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/**
 * Whether a URL is one we would follow, read the way a browser reads it.
 *
 * Checked at every stage of decoding rather than once: the value is written
 * back out as it came, so whatever number of decodings stands between it and
 * the browser, none of them may arrive at a scheme we do not trust.
 */
function safeUrl(url) {
  let seen = url;
  for (let pass = 0; pass < 8; pass++) {
    const scheme = LEADING_SCHEME.exec(seen);
    if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return false;
    const next = decodeEntities(seen).replace(INVISIBLE, '');
    if (next === seen) return true;
    seen = next;
  }
  return false;   // still unwinding after eight layers is not a link
}

/**
 * Declarations that let content leave its box or cover the app's own UI.
 * position:fixed across the screen is how a work skin stops being a work skin
 * and starts being a phishing overlay. A url() is a request to somebody
 * else's server every time the page is read, which is the tracking pixel the
 * reader already refuses in an <img>.
 */
const UNSAFE_CSS = /@import|@font-face|@namespace|expression\s*\(|behaviou?r\s*:|-moz-binding|url\s*\(|image-set\s*\(|\bsrc\s*\(/;
const SAFE_POSITION = new Set(['static', 'relative', 'absolute', 'inherit', 'initial', 'unset', 'revert']);

/** A piece of CSS as the browser understands it: no comments, no escapes. */
function cssMeaning(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|(\r\n|[\n\r\f])|([\s\S]))/gi, (whole, hex, newline, ch) => {
      if (newline) return '';
      if (ch) return ch;
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
    })
    .toLowerCase();
}

/**
 * One selector, at-rule prelude or declaration: may it stay?
 *
 * Judged by meaning, and whole. Removing the offending substring is what let
 * `posit@importion:fixed` through — taking out the middle is what joined the
 * two ends — and `\66ixed` never contained the word that was being looked for.
 */
function cssPieceIsSafe(piece) {
  const meaning = cssMeaning(piece);
  if (UNSAFE_CSS.test(meaning)) return false;
  const declaration = /^\s*([-\w]+)\s*:([\s\S]*)$/.exec(meaning);
  if (!declaration) return true;
  const value = declaration[2].replace(/!\s*important/g, '').trim();
  /* An allowlist, because `position: var(--p)` is fixed too if --p says so. */
  if (declaration[1] === 'position') return SAFE_POSITION.has(value);
  if (declaration[1] === 'z-index') return value === 'auto' || /^[-+]?\d{1,2}$/.test(value);
  return true;
}

/**
 * CSS with every unsafe piece taken out whole.
 *
 * Split where a browser splits — at braces and semicolons that are not inside
 * a string or a bracket — so the pieces judged here are the pieces it sees.
 * An unsafe declaration goes; an unsafe prelude takes its whole block with it.
 */
function cleanCss(css) {
  const input = String(css ?? '').replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
  let out = '';
  let piece = '';
  let quote = '';
  let depth = 0;
  let skipping = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\') { piece += ch + (input[i + 1] ?? ''); i++; continue; }
    if (quote) { piece += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; piece += ch; continue; }
    if (ch === '(' || ch === '[') { depth++; piece += ch; continue; }
    if ((ch === ')' || ch === ']') && depth) { depth--; piece += ch; continue; }
    if (depth || !(ch === '{' || ch === '}' || ch === ';')) { piece += ch; continue; }

    if (skipping) {
      if (ch === '{') skipping++;
      if (ch === '}') skipping--;
      piece = '';
      continue;
    }
    const safe = cssPieceIsSafe(piece);
    if (ch === '{') {
      if (safe) out += piece + '{'; else skipping = 1;
    } else if (ch === ';') {
      if (safe) out += piece + ';';
    } else {
      out += (safe ? piece : '') + '}';
    }
    piece = '';
  }
  // Whatever is left never closed. It is kept only if it is harmless as it stands.
  if (!skipping && !quote && !depth && cssPieceIsSafe(piece)) out += piece;
  return out;
}

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
    if (!safeUrl(url)) return null;
    return url;
  }
  if (name === 'style') {
    /* The browser decodes the attribute before it parses the CSS, so the CSS
       is judged decoded — and written back with every ampersand escaped, so
       what the browser decodes is exactly what was judged. */
    const cleaned = cleanCss(decodeEntities(value)).trim();
    return cleaned ? { verbatim: cleaned } : null;
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
      if (safe === null) continue;
      kept.push(name + '="' + (typeof safe === 'object'
        ? safe.verbatim.replace(/[&<>"]/g, (c) => ESCAPE[c])
        : escapeAttr(safe)) + '"');
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
  return cleanCss(css);
}
