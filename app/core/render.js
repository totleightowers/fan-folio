/**
 * Turning a stored work into something safe to display.
 *
 * Two untrusted things arrive from AO3: the chapter HTML and the author's work
 * skin. Both are written by strangers, and the reader shows them inside the
 * app's own origin, next to the session cookie. So neither is rendered as-is.
 *
 * The goal is faithfulness, not sterility. Fics use alignment, colour, custom
 * fonts, chat bubbles and image layouts deliberately, and stripping all of it
 * would make this worse than the app it replaces. What gets removed is only
 * what can execute, escape the reading pane, or phone home.
 */

/* Elements that can run code or load third parties. Dropped with their content. */
const DROP_WHOLE = /<(script|iframe|object|embed|link|meta|form|base)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

/* Anything on*= is a handler. Anything javascript:/data: in a URL can execute. */
const EVENT_ATTR = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const BAD_URL_ATTR = /\s(href|src|xlink:href)\s*=\s*("|')?\s*(javascript|vbscript|data):[^"'\s>]*("|')?/gi;

/**
 * Declarations that let content leave its box or cover the app's own UI.
 * position:fixed over the whole screen is the classic way a "work skin" stops
 * being a work skin and starts being a phishing overlay.
 */
const ESCAPING_CSS = /(position\s*:\s*(fixed|sticky))|(z-index\s*:\s*\d{3,})|(@import\b)|(expression\s*\()|(behaviou?r\s*:)|(-moz-binding)/gi;

export function sanitiseHtml(html, { allowRemoteImages = false } = {}) {
  if (!html) return '';
  let out = String(html);
  out = out.replace(DROP_WHOLE, '');
  out = out.replace(EVENT_ATTR, '');
  out = out.replace(BAD_URL_ATTR, '');
  out = out.replace(/\sstyle\s*=\s*"([^"]*)"/gi, (whole, css) =>
    ESCAPING_CSS.test(css) ? ` style="${css.replace(ESCAPING_CSS, '')}"` : whole);
  if (!allowRemoteImages) {
    /*
     * Every image source is neutralised, remote or not.
     *
     * A remote <img> left intact is a tracking pixel reporting when and where a
     * fic was read. A *relative* one — "img7.jpg", pointing inside the EPUB it
     * came from — simply 404s and renders as a broken-image icon, which is what
     * 722 images across 192 works were doing. Both are replaced with a marked
     * placeholder that renderChapter swaps for the stored copy when there is
     * one, so an image is either real or visibly absent, never broken.
     */
    out = out.replace(/<img\b([^>]*?)\ssrc\s*=\s*("|')([^"']*)\2/gi,
      (whole, pre, q, url) => (url.startsWith('/img/')
        ? whole
        : `<img${pre} data-remote-src=${q}${url}${q} src="" class="ar-missing-image"`));
  }
  return out;
}

/**
 * Confine a work skin to the work.
 *
 * AO3 asks authors to scope skins under #workskin, and mostly they do — but
 * "mostly" is not a security property, and a rule on `body` or `*` would
 * repaint the whole app. Every selector is rewritten to sit under the given
 * root, so a skin can only ever affect the pane it belongs to.
 */
export function scopeCss(css, root = '#workskin') {
  if (!css) return '';
  const clean = String(css)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(ESCAPING_CSS, '');

  const out = [];
  let i = 0;
  while (i < clean.length) {
    const brace = clean.indexOf('{', i);
    if (brace === -1) break;

    const prelude = clean.slice(i, brace).trim();

    // @media and friends wrap rules; scope what is inside them instead
    if (prelude.startsWith('@')) {
      const end = matchingBrace(clean, brace);
      const body = clean.slice(brace + 1, end);
      if (/^@(media|supports|layer)/i.test(prelude)) {
        out.push(`${prelude} { ${scopeCss(body, root)} }`);
      }
      // @font-face, @keyframes and the rest carry no selectors to scope and
      // are left out entirely rather than guessed at
      i = end + 1;
      continue;
    }

    const end = matchingBrace(clean, brace);
    const body = clean.slice(brace + 1, end).trim();
    const selectors = prelude.split(',').map((s) => s.trim()).filter(Boolean).map((sel) => {
      // a skin that already scopes itself must not end up double-scoped
      if (sel.startsWith(root)) return sel;
      if (/^(html|body|:root)\b/i.test(sel)) return `${root}${sel.replace(/^(html|body|:root)/i, '')}`.trim() || root;
      return `${root} ${sel}`;
    });
    if (body) out.push(`${selectors.join(', ')} { ${body} }`);
    i = end + 1;
  }
  return out.join('\n');
}

function matchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length;
}

/**
 * Put AO3's own class names back.
 *
 * Calibre rewrote the markup when the EPUB was made: it renamed `userstuff` to
 * `userstuff1`/`userstuff2` and sprayed generated `calibre7`-style classes over
 * every element. AO3's stylesheet targets `.userstuff`, and a work skin is
 * written against AO3's markup, so both miss unless the names are restored.
 *
 * The generated classes are dropped rather than kept: they carry Calibre's own
 * margins and display rules, which fight AO3's and produce spacing the author
 * never intended. Author classes are untouched — those are the work.
 */
export function normaliseAo3Classes(html) {
  return String(html).replace(/\sclass="([^"]*)"/gi, (whole, value) => {
    const kept = value.split(/\s+/)
      .map((c) => c.replace(/^userstuff\d+$/i, 'userstuff'))
      .filter((c) => c && !/^calibre\d*$/i.test(c));
    return kept.length ? ` class="${[...new Set(kept)].join(' ')}"` : '';
  });
}

/** Everything the reader needs for one chapter, ready to insert. */
export function renderChapter(chapter, { skinCss = null, images = new Map() } = {}) {
  let html = sanitiseHtml(normaliseAo3Classes(chapter.html), { allowRemoteImages: false });

  /*
   * Swap in anything captured locally.
   *
   * The URL is matched in both forms it can take. Image URLs carry query
   * strings, so the markup holds `&amp;` where the stored record — decoded
   * when the URL was extracted — holds `&`. Matching only one form silently
   * left every captured image showing its "not stored" placeholder.
   */
  for (const [url, local] of images) {
    for (const form of new Set([url, url.replace(/&/g, '&amp;')])) {
      html = html.replace(
        new RegExp(`(<img[^>]*\\bdata-remote-src="${escapeRe(form)}"[^>]*?)\\ssrc=""`, 'gi'),
        `$1 src="${local}" data-stored="1"`
      );
    }
  }
  // an image that rendered is no longer missing
  html = html.replace(/(<img[^>]*\bdata-stored="1"[^>]*)\sclass="ar-missing-image"/gi, '$1');
  html = html.replace(/(<img[^>]*\bdata-stored="1"[^>]*)\salt="image not stored"/gi, '$1');

  return { title: chapter.title, html, css: skinCss ? scopeCss(skinCss) : '' };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
