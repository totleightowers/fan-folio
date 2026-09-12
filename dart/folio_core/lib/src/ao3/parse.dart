/// Reading the archive's pages.
///
/// A parser is the one place in this app where being subtly wrong is
/// invisible: a work with the wrong tags, a chapter count off by one, an
/// author dropped from a byline — none of it announces itself. It sits in the
/// library looking like data. So this is held to what the 1.x parser extracts
/// from the same saved pages, rather than to my reading of the markup.
///
/// Where 1.x matches with regular expressions, this uses a real HTML parser.
/// That is not tidiness: fic markup and the archive's own templates are not
/// always well-formed, and a parser that recovers the way a browser recovers
/// reads pages that a pattern gives up on. The conformance fixture is what
/// makes that safe to do.
library;

import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html;

import 'text.dart';

/// One work as a listing describes it.
class Blurb {
  const Blurb({
    required this.workId,
    required this.title,
    required this.authors,
    required this.anonymous,
    required this.fandoms,
    required this.warnings,
    required this.relationships,
    required this.characters,
    required this.freeform,
    required this.categories,
    required this.complete,
    this.bookmarkId,
    this.updatedAt,
    this.datetime,
    this.rating,
    this.summary,
    this.language,
    this.words,
    this.chapters,
    this.chaptersPlanned,
    this.kudos,
    this.hits,
    this.bookmarkCount,
  });

  final String workId;
  final String? bookmarkId;
  final String? title;
  final List<String> authors;
  final bool anonymous;

  /// The archive emits the exact epoch in a comment; the visible "26 Aug 2026"
  /// is a lossy rendering of it and would compare wrongly across timezones.
  final int? updatedAt;
  final String? datetime;
  final List<String> fandoms;
  final String? rating;
  final List<String> categories;
  final bool complete;
  final List<String> warnings;
  final List<String> relationships;
  final List<String> characters;
  final List<String> freeform;
  final String? summary;
  final String? language;
  final int? words;
  final int? chapters;
  final int? chaptersPlanned;
  final int? kudos;
  final int? hits;
  final int? bookmarkCount;
}

class Listing {
  const Listing(
      {required this.works, required this.current, required this.total});
  final List<Blurb> works;
  final int current;
  final int total;
}

String? _text(dom.Element? el) {
  if (el == null) return null;
  final text = el.text.replaceAll(RegExp(r'\s+'), ' ').trim();
  return text.isEmpty ? null : text;
}

/// The text of a block, with its paragraph breaks kept.
String? _blockText(dom.Element? el) {
  if (el == null) return null;
  final text = htmlToText(el.innerHtml);
  return text.isEmpty ? null : text;
}

int? _number(String? text) {
  if (text == null) return null;
  final digits = text.replaceAll(RegExp(r'[^\d]'), '');
  return digits.isEmpty ? null : int.tryParse(digits);
}

List<String> _tagsIn(dom.Element? within, [String? selector]) {
  if (within == null) return const [];
  final scope = selector == null ? within : null;
  final nodes = scope != null
      ? scope.querySelectorAll('a.tag')
      : within.querySelectorAll('$selector a.tag');
  return nodes.map((a) => _text(a)).whereType<String>().toList();
}

/// One blurb — the shape the archive uses for a work in any list.
Blurb? parseBlurb(dom.Element li) {
  /* On a bookmark blurb the element id belongs to the bookmark, and the work
     id is hiding in the class list as "work-123". */
  final id = li.id;
  final fromId = RegExp(r'^work_(\d+)$').firstMatch(id)?.group(1);
  final fromClass = li.classes
      .map((c) => RegExp(r'^work-(\d+)$').firstMatch(c)?.group(1))
      .whereType<String>()
      .firstOrNull;
  final workId = fromId ?? fromClass;
  if (workId == null) return null;

  final header = li.querySelector('h4.heading');
  final titleLink = header
      ?.querySelectorAll('a')
      .where(
        (a) => (a.attributes['href'] ?? '').contains('/works/'),
      )
      .firstOrNull;
  final authors =
      (header?.querySelectorAll('a[rel=author]') ?? const <dom.Element>[])
          .map((a) => _text(a))
          .whereType<String>()
          .toList();

  final symbols = li.querySelector('ul.required-tags');
  String? title(String kind) =>
      symbols?.querySelector('span.$kind')?.attributes['title'];

  final stats = li.querySelector('dl.stats');
  String? stat(String name) => _text(stats?.querySelector('dd.$name'));

  final chapters = stat('chapters') ?? '';
  final parts = chapters.split('/');
  final planned = parts.length > 1 ? parts[1].trim() : '';

  final tagList = li.querySelector('ul.tags');
  List<String> group(String cls) =>
      (tagList?.querySelectorAll('li.$cls a.tag') ?? const <dom.Element>[])
          .map((a) => _text(a))
          .whereType<String>()
          .toList();

  final category = title('category');

  return Blurb(
    workId: workId,
    bookmarkId: RegExp(r'^bookmark_(\d+)$').firstMatch(id)?.group(1),
    title: _text(titleLink),
    authors: authors,
    anonymous: authors.isEmpty || li.outerHtml.contains('anonymous'),
    updatedAt: _updatedAt(li),
    datetime: _text(li.querySelector('p.datetime')),
    fandoms: _tagsIn(li.querySelector('h5.fandoms')),
    rating: title('rating'),
    categories: category == null || category.isEmpty
        ? const []
        : category.split(RegExp(r'\s*,\s*')),
    complete: li.querySelector('span.complete-no.iswip') == null,
    warnings: group('warnings'),
    relationships: group('relationships'),
    characters: group('characters'),
    freeform: group('freeforms'),
    // through htmlToText, so a summary reads the same in both versions: a
    // whitespace collapse would run its paragraphs together
    summary: _blockText(li.querySelector('blockquote.summary')),
    language: stat('language'),
    words: _number(stat('words')),
    chapters: _number(parts.first),
    chaptersPlanned:
        planned.isEmpty || planned == '?' ? null : _number(planned),
    kudos: _number(stat('kudos')),
    hits: _number(stat('hits')),
    bookmarkCount: _number(stat('bookmarks')),
  );
}

int? _updatedAt(dom.Element li) {
  for (final node in li.nodes) {
    if (node is dom.Comment) {
      final m = RegExp(r'updated_at=(\d+)').firstMatch(node.data ?? '');
      if (m != null) return int.tryParse(m.group(1)!);
    }
  }
  final m = RegExp(r'updated_at=(\d+)').firstMatch(li.outerHtml);
  return m == null ? null : int.tryParse(m.group(1)!);
}

/// A page of works: what is on it, and how many pages there are.
Listing parseListing(String? page) {
  final doc = html.parse(page ?? '');
  final works = doc
      .querySelectorAll('li.work.blurb, li.bookmark.blurb, li.blurb')
      .map(parseBlurb)
      .whereType<Blurb>()
      .toList();

  // deduplicated by id: a bookmark blurb and a work blurb can both match
  final seen = <String>{};
  final unique = works.where((w) => seen.add(w.workId)).toList();

  final pages = doc
      .querySelectorAll('ol.pagination li a, ol.pagination li span')
      .map((el) => int.tryParse(el.text.trim()))
      .whereType<int>()
      .toList();
  final current = int.tryParse(
        _text(doc.querySelector('ol.pagination li span.current')) ?? '',
      ) ??
      1;

  return Listing(
    works: unique,
    current: current,
    total: [current, ...pages, 1].reduce((a, b) => a > b ? a : b),
  );
}

/// One chapter of a work, as the full-work view lays it out.
class ChapterPart {
  const ChapterPart({required this.number, this.title, required this.html});
  final int number;
  final String? title;
  final String html;
}

/// A work, read from its own page.
class WorkPage {
  const WorkPage({
    required this.workId,
    required this.title,
    required this.authors,
    required this.chapters,
    required this.tags,
    required this.fandoms,
    this.summary,
    this.language,
    this.rating,
    this.words,
    this.complete = false,
    this.skinCss,
  });

  final String? workId;
  final String? title;
  final List<String> authors;
  final List<ChapterPart> chapters;
  final Map<String, List<String>> tags;
  final List<String> fandoms;
  final String? summary;
  final String? language;
  final String? rating;
  final int? words;
  final bool complete;

  /// The author's own CSS, which is the work as much as the text is.
  final String? skinCss;
}

WorkPage parseWorkPage(String? page, {String? workId}) {
  final doc = html.parse(page ?? '');

  final id = workId ??
      RegExp(r'/works/(\d+)')
          .firstMatch(
            doc.querySelector('li.share a')?.attributes['href'] ?? '',
          )
          ?.group(1) ??
      RegExp(r'/works/(\d+)').firstMatch(page ?? '')?.group(1);

  /* The skin is the <style> the archive injects inside the #work-skin
     wrapper — not the wrapper, which contains the entire work. Taking the
     wrapper's text made every work look skinned, which would have sent the
     whole library to the WebView reader and made the native one dead code.
     Anchoring on the pair matters the other way too: the page has other
     <style> blocks, and one of those would apply site chrome to the story. */
  final skin = doc.querySelector('#work-skin style')?.text.trim() ??
      doc.querySelector('style#work-skin')?.text.trim();

  final meta = doc.querySelector('dl.work.meta');
  List<String> metaTags(String cls) =>
      (meta?.querySelectorAll('dd.$cls a.tag') ?? const <dom.Element>[])
          .map((a) => _text(a))
          .whereType<String>()
          .toList();

  final chapters = <ChapterPart>[];
  // descendant, not child: the archive nests them a level deeper than
  // the id suggests, and a child selector finds none of them
  /* A chapter is a div.chapter with an id of its own. The per-chapter notes
     blocks are "chapter preface group", which carries the same class and is
     not a chapter — counting those makes a two-chapter work into a five. */
  final divisions = doc
      .querySelectorAll('#chapters div.chapter')
      .where((el) => RegExp(r'^chapter-\d+$').hasMatch(el.id))
      .toList();
  if (divisions.isEmpty) {
    final only = doc.querySelector('#chapters .userstuff');
    if (only != null) {
      chapters.add(ChapterPart(number: 1, html: only.innerHtml));
    }
  } else {
    for (var i = 0; i < divisions.length; i++) {
      final division = divisions[i];
      final heading = _text(division.querySelector('h3.title'));
      final body = division.querySelector('.userstuff') ?? division;
      chapters.add(ChapterPart(
        number: i + 1,
        title: _chapterTitle(heading),
        html: body.innerHtml,
      ));
    }
  }

  final stats = doc.querySelector('dl.stats');
  final chapterStat = _text(stats?.querySelector('dd.chapters')) ?? '';
  final split = chapterStat.split('/');

  return WorkPage(
    workId: id,
    title: _text(doc.querySelector('h2.title.heading')),
    authors: doc
        .querySelectorAll('h3.byline a[rel=author]')
        .map((a) => _text(a))
        .whereType<String>()
        .toList(),
    chapters: chapters,
    tags: {
      'warning': metaTags('warning'),
      'relationship': metaTags('relationship'),
      'character': metaTags('character'),
      'freeform': metaTags('freeform'),
      'category': metaTags('category'),
    },
    fandoms: metaTags('fandom'),
    summary: _blockText(doc.querySelector('.summary blockquote.userstuff')),
    language: _text(doc.querySelector('dd.language')),
    rating: metaTags('rating').firstOrNull,
    words: _number(_text(stats?.querySelector('dd.words'))),
    complete: split.length > 1 && split[0].trim() == split[1].trim(),
    skinCss: skin == null || skin.isEmpty ? null : skin,
  );
}

/// "Chapter 3: The Cold Open" is a heading; the title is what follows the colon.
String? _chapterTitle(String? heading) {
  if (heading == null) return null;
  final m = RegExp(r'^Chapter\s+\d+\s*:?\s*(.*)$').firstMatch(heading);
  final rest = (m == null ? heading : m.group(1) ?? '').trim();
  return rest.isEmpty ? null : rest;
}
