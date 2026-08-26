/**
 * Turn an AO3 EPUB into a record the reader can store, search and display.
 *
 * These files have been through Calibre (FanFicFare's usual path), which
 * rewrites the packaging but leaves AO3's own preface intact. That preface is
 * the only place the work id survives, and the work id is what ties a file on
 * disk to a work on AO3 — for updates, for history, for "do I already have
 * this?". Without it a fic is an orphan, so it is extracted first and treated
 * as the identity of the record.
 */

import { readZip } from './zip.js';

const NS = { opf: 'http://www.idpf.org/2007/opf' };

/* ------------------------------------------------------------------- text */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”',
};

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const known = ENTITIES[body.toLowerCase()];
    return known === undefined ? whole : known;
  });
}

/**
 * Markup to plain text, for indexing and word counts.
 *
 * Block-level tags become newlines rather than nothing: without that,
 * "end.</p><p>Next" indexes as "end.Next" and the phrase search for a
 * sentence spanning a paragraph break quietly fails.
 */
/**
 * Repeat a removal until it stops changing anything — see render.js.
 *
 * Uncapped on purpose: every pass that changes the string shortens it, so this
 * terminates, and stopping early would mean returning markup that still
 * contains what was being removed.
 */
function stripUntilStable(text, pattern) {
  let out = String(text);
  let previous;
  do {
    previous = out;
    out = out.replace(pattern, '');
  } while (out !== previous);
  return out;
}

export function htmlToText(html) {
  return decodeEntities(
    // an unclosed <script> must go too, or the tag survives and only its
    // content is stripped by the generic tag removal below
    stripUntilStable(String(html ?? ''), /<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi)
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  ).replace(/[ \t ]+/g, ' ')
   .replace(/\n\s*\n\s*\n+/g, '\n\n')
   .trim();
}

export function countWords(text) {
  const m = text.match(/[\p{L}\p{N}'’-]+/gu);
  return m ? m.length : 0;
}

/* -------------------------------------------------------------------- xml */

/** Attribute lookup that tolerates single quotes and attribute order. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3]) : null;
}

function tags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}\\b([^>]*)(?:/>|>([\\s\\S]*?)</${name}>)`, 'gi'))]
    .map((m) => ({ attrs: m[1] || '', body: m[2] ?? '' }));
}

function textOf(xml, name) {
  const found = tags(xml, name)[0];
  return found ? decodeEntities(found.body).trim() : null;
}

/* ----------------------------------------------------------------- preface */

/**
 * AO3 writes the work id into the preface as a sentence, not as metadata:
 *
 *   Posted originally on the <a ...>Archive of Our Own</a> at
 *   <a href="http://archiveofourown.org/works/23690653">…</a>.
 *
 * Anchored on that sentence rather than on the first AO3 link in the file,
 * because author notes routinely link other works and letting one of those
 * become the record's identity would silently merge two fics. The bounded
 * gap keeps the anchor honest — it cannot wander into the body text.
 */
export function findWorkId(html) {
  const m = html.match(
    /Posted originally on the[\s\S]{0,300}?archiveofourown\.org\/works\/(\d+)/i
  );
  return m ? m[1] : null;
}

/** "Published: 2020-04-16 Completed: 2021-09-06 Words: 100,392 Chapters: 31/31" */
export function parseStats(text) {
  const out = {};
  const date = (label) => text.match(new RegExp(`${label}:\\s*(\\d{4}-\\d{2}-\\d{2})`, 'i'))?.[1] ?? null;
  out.published = date('Published');
  // a finished work says Completed, a work in progress says Updated
  out.completed = date('Completed');
  out.updated = date('Updated') ?? out.completed;

  const words = text.match(/Words:\s*([\d,]+)/i);
  if (words) out.words = Number(words[1].replace(/,/g, ''));

  const chapters = text.match(/Chapters:\s*(\d+)\s*\/\s*(\d+|\?)/i);
  if (chapters) {
    out.chapters = Number(chapters[1]);
    out.chaptersPlanned = chapters[2] === '?' ? null : Number(chapters[2]);
    // "31/31" is finished; "31/?" and "12/31" are not. Completed being set is
    // the stronger signal, so it wins where the two disagree.
    out.complete = out.completed !== null || out.chapters === out.chaptersPlanned;
  }
  return out;
}

/**
 * The preface's definition list carries the tag groups separately, which the
 * OPF's flat dc:subject list has already thrown together. Recovering them
 * lets the reader show "Relationship:" instead of one undivided heap.
 *
 * Tags come from the individual <a> elements, never from splitting the joined
 * text on commas: fandom tags contain commas constantly ("oh my god, they
 * were roommates") and comma-splitting shreds them into nonsense.
 */
export function parsePreface(html) {
  const out = {};
  const body = html.replace(/\s+/g, ' ');
  const groups = [
    ['rating', 'Rating'], ['warnings', 'Archive Warning'], ['categories', 'Category'],
    ['fandoms', 'Fandom'], ['relationships', 'Relationship'], ['characters', 'Character'],
    ['freeform', 'Additional Tags'], ['series', 'Series'], ['collections', 'Collections'],
  ];
  for (const [key, label] of groups) {
    const m = body.match(new RegExp(`<dt[^>]*>\\s*${label}s?:?\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, 'i'));
    if (!m) continue;
    const dd = m[1];
    const anchors = [...dd.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((a) => htmlToText(a[1]))
      .filter(Boolean);
    const values = anchors.length ? anchors : htmlToText(dd).split(/\s*,\s*/).filter(Boolean);
    out[key] = key === 'rating' ? (values[0] ?? null) : values;
  }

  const stats = body.match(/<dt[^>]*>\s*Stats:?\s*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
  if (stats) Object.assign(out, parseStats(htmlToText(stats[1])));
  return out;
}

/**
 * The readable part of an XHTML document.
 *
 * EPUB spine items are whole documents — xml declaration, head, the lot.
 * Storing all of that means the reader renders <head> markup into the page and
 * the search index contains every <title>. Only the body is content.
 */
export function bodyOf(html) {
  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
}

/* ------------------------------------------------------------------- epub */

function resolve(base, href) {
  if (!base) return href;
  const parts = base.split('/').slice(0, -1);
  for (const seg of href.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export async function parseEpub(bytes) {
  const files = await readZip(bytes);
  const decode = (name) => {
    const raw = files.get(name);
    return raw ? new TextDecoder('utf-8').decode(raw) : null;
  };

  const container = decode('META-INF/container.xml');
  if (!container) throw new Error('no META-INF/container.xml — not an EPUB');
  const opfPath = attr(tags(container, 'rootfile')[0]?.attrs ?? '', 'full-path');
  if (!opfPath) throw new Error('container.xml names no rootfile');
  const opf = decode(opfPath);
  if (!opf) throw new Error(`missing ${opfPath}`);

  const metadata = tags(opf, 'metadata')[0]?.body ?? opf;
  const manifest = new Map(
    tags(opf, 'item').map(({ attrs }) => [attr(attrs, 'id'), {
      href: resolve(opfPath, attr(attrs, 'href') || ''),
      type: attr(attrs, 'media-type'),
    }])
  );
  const spine = tags(opf, 'itemref')
    .map(({ attrs }) => manifest.get(attr(attrs, 'idref')))
    .filter((item) => item && /xhtml|html/.test(item.type || ''));

  const chapters = [];
  let workId = null;
  let preface = {};

  // Decode the spine once, then decide what is a chapter — the decision needs
  // to see the whole book, not one document at a time.
  const docs = [];
  for (const [index, item] of spine.entries()) {
    const html = decode(item.href);
    if (html === null) continue;
    docs.push({ index, href: item.href, html, body: bodyOf(html) });
  }

  for (const d of docs) {
    if (workId !== null) break;
    const found = findWorkId(d.html);
    if (found) { workId = found; preface = parsePreface(d.html); }
  }

  /*
   * AO3 marks the story body with id="chapters". Calibre's split puts the title
   * page in a document carrying both that marker and id="preface", and the end
   * notes in one carrying only id="afterword" — so a chapter is a document
   * with the chapters marker and without the preface marker. Verified against
   * one-shots as well as long works: in both, the prose lands in a document
   * with id="chapters" and no preface marker, so nothing is lost.
   *
   * Excluding on id="preface"/id="afterword" instead looks equivalent and is
   * not: Calibre's splitter puts the afterword marker in the same document as
   * the final chapter, so that rule silently discarded a real 3,300-word
   * chapter from every completed work — 19.5 million words across the library.
   *
   * The fallback covers books built by some other tool that never emits the
   * marker; there, absence of a chapters marker everywhere means it carries no
   * information, and the weaker rule is better than keeping nothing.
   */
  const marked = docs.filter((d) => /\bid="chapters"/i.test(d.body)
    && !/\bid="preface"/i.test(d.body));

  /*
   * The author's end notes.
   *
   * Where Calibre keeps them in the same document as the final chapter they
   * survive as part of that chapter. Where it splits them out they carry no
   * chapters marker, so they were being discarded — roughly 74,000 words of
   * author's notes across the library, the longest a single 669-word note.
   * They are content, not packaging, so they are kept and shown after the
   * last chapter rather than silently dropped.
   */
  const endNoteDocs = docs.filter((d) => /\bid="afterword"/i.test(d.body)
    && !/\bid="chapters"/i.test(d.body));
  const endNotesHtml = endNoteDocs.map((d) => d.body).join('\n');
  const chapterDocs = marked.length
    ? marked
    : docs.filter((d) => !/\bid="(preface|afterword)"/i.test(d.body));

  for (const d of chapterDocs) {
    const title = htmlToText(d.body.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1] ?? '') || null;
    const text = htmlToText(d.body);
    if (!text) continue;
    chapters.push({ index: d.index, href: d.href, title, html: d.body, text, words: countWords(text) });
  }

  // When this file was made — i.e. the moment AO3's version was captured.
  // This is the only honest answer to "is our copy current?": comparing AO3's
  // updated_at against the work's *publication* date instead flags every work
  // ever revised after posting, which is most of them.
  const downloadedAt = metadata.match(/name="calibre:timestamp"\s+content="([^"]+)"/i)?.[1]
    ?? opf.match(/name="calibre:timestamp"\s+content="([^"]+)"/i)?.[1]
    ?? null;

  const subjects = tags(metadata, 'dc:subject').map((t) => decodeEntities(t.body).trim()).filter(Boolean);
  const text = chapters.map((c) => c.text).join('\n\n');

  return {
    workId,
    downloadedAt: downloadedAt ? downloadedAt.slice(0, 10) : null,
    title: textOf(metadata, 'dc:title'),
    authors: tags(metadata, 'dc:creator').map((t) => decodeEntities(t.body).trim()).filter(Boolean),
    summary: textOf(metadata, 'dc:description') ? htmlToText(textOf(metadata, 'dc:description')) : null,
    language: textOf(metadata, 'dc:language'),
    published: textOf(metadata, 'dc:date'),
    subjects,
    ...preface,
    chapters,
    endNotesHtml: endNotesHtml || null,
    words: countWords(text),
  };
}
