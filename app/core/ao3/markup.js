/**
 * Rebuild AO3's own markup from stored data.
 *
 * The work page's meta block — rating, warnings, fandoms, relationships,
 * characters, tags, stats — is a `dl.work.meta.group`, and AO3's stylesheet
 * styles exactly that structure. Generating it rather than storing AO3's HTML
 * means every one of the 1596 works looks like AO3 immediately, with no fetch:
 * the data is already here, only the shape was missing.
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const fmt = (n) => (n == null ? null : Number(n).toLocaleString('en-GB'));

/* EPUBs record a language code; AO3 shows the language. "en" is not a word. */
const LANGUAGES = {
  en: 'English', fr: 'Français', es: 'Español', de: 'Deutsch', it: 'Italiano',
  pt: 'Português', ru: 'Русский', zh: '中文', ja: '日本語', ko: '한국어',
  nl: 'Nederlands', pl: 'Polski', sv: 'Svenska', tr: 'Türkçe', id: 'Bahasa Indonesia',
};
const languageName = (code) => {
  if (!code) return null;
  const key = String(code).toLowerCase().split(/[-_]/)[0];
  return LANGUAGES[key] ?? code;
};

/** AO3 renders each tag as a link; offline they are the same shape, inert. */
/**
 * A row of values, each one a way into the library.
 *
 * These were spans: the work page told you it was Fluff and left you to go and
 * type that somewhere else. They carry what they filter by rather than relying
 * on their own text, because the label shown and the value filtered on are not
 * always the same thing — a language reads "English" and filters on "en".
 *
 * `filter` says which kind of narrowing the value is: most are tags, but a
 * rating is a column on the work and not a tag at all.
 */
function tagList(kind, names, filter = 'tag') {
  if (!names?.length) return '';
  const items = names.map((n) =>
    `<li class="${kind}">${pill(filter, n, n)}</li>`).join('');
  return `<ul class="commas">${items}</ul>`;
}

/** One tappable value. The classes are AO3's, so its stylesheet still applies. */
function pill(filter, value, label) {
  return `<button type="button" class="tag metapill"`
    + ` data-filter="${esc(filter)}" data-value="${esc(value)}">${esc(label)}</button>`;
}

function row(cssClass, label, valueHtml) {
  if (!valueHtml) return '';
  return `<dt class="${cssClass}">${esc(label)}:</dt><dd class="${cssClass}">${valueHtml}</dd>`;
}

/**
 * The stats line, in AO3's order and wording.
 *
 * Chapters read "31/31" or "18/?" exactly as the site writes them — a work in
 * progress and a finished one must be distinguishable at a glance, and the
 * question mark is how AO3 says "the author has not said".
 */
function statsRow(work) {
  const parts = [];
  if (work.published) parts.push(`<dt class="published">Published:</dt><dd class="published">${esc(work.published)}</dd>`);
  if (work.updated && work.updated !== work.published) {
    const label = work.complete ? 'Completed' : 'Updated';
    parts.push(`<dt class="status">${label}:</dt><dd class="status">${esc(work.updated)}</dd>`);
  }
  if (work.words != null) parts.push(`<dt class="words">Words:</dt><dd class="words">${fmt(work.words)}</dd>`);
  const planned = work.chapters_planned ?? '?';
  parts.push(`<dt class="chapters">Chapters:</dt><dd class="chapters">${esc(work.chapter_count)}/${esc(planned)}</dd>`);
  if (!parts.length) return '';
  return `<dt class="stats">Stats:</dt><dd class="stats"><dl class="stats">${parts.join('')}</dl></dd>`;
}

export function workMetaHtml(work, tags = {}) {
  const rows = [
    row('rating tags', 'Rating', tagList('rating', work.rating ? [work.rating] : [], 'rating')),
    row('warning tags', 'Archive Warning', tagList('warnings', tags.warning)),
    row('category tags', 'Category', tagList('category', tags.category)),
    row('fandom tags', 'Fandom', tagList('fandoms', tags.fandom)),
    row('relationship tags', 'Relationship', tagList('relationships', tags.relationship)),
    row('character tags', 'Character', tagList('characters', tags.character)),
    row('freeform tags', 'Additional Tags', tagList('freeforms', tags.freeform)),
    row('language', 'Language',
      work.language ? pill('language', work.language, languageName(work.language)) : ''),
    row('collections', 'Collections', tagList('collections', tags.collection)),
    statsRow(work),
  ].filter(Boolean).join('');
  return `<dl class="work meta group">${rows}</dl>`;
}

/**
 * The preface AO3 shows above chapter one: title, byline, summary.
 * Same classes AO3 uses, so its stylesheet and any work skin both apply.
 */
export function workPrefaceHtml(work, authors = []) {
  const byline = authors.length
    ? authors.map((a) =>
        `<button type="button" class="author metapill" data-filter="author"`
        + ` data-value="${esc(a)}">${esc(a)}</button>`).join(', ')
    : '<span class="author">Anonymous</span>';
  const summary = work.summary
    ? `<div class="summary module"><h3 class="heading">Summary:</h3>
         <blockquote class="userstuff"><p>${esc(work.summary).replace(/\n+/g, '</p><p>')}</p></blockquote>
       </div>`
    : '';
  return `<div class="preface group">
    <h2 class="title heading">${esc(work.title ?? 'Untitled')}</h2>
    <h3 class="byline heading">${byline}</h3>
    ${summary}
  </div>`;
}
