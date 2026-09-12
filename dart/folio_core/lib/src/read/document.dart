/// A chapter, turned into something that can be laid out as native text.
///
/// 2.x reads most works as native text and only falls back to a WebView for
/// works carrying an author's skin. This is the half of that which can be
/// tested without a phone: chapter HTML in, blocks and runs out. Whether a
/// paragraph is centred, whether a word is emphasised, where a line breaks —
/// all decided here, where a test can ask.
///
/// Faithfulness is the goal, as it is in 1.x. Fic uses alignment, emphasis,
/// horizontal rules and images deliberately, and a renderer that flattened
/// them would be worse than the WebView it replaces. What is dropped is only
/// what has no meaning as text.
library;

import 'package:html/dom.dart' as dom;
import 'package:html/parser.dart' as html;

/// What is being done to a run of text.
enum Mark {
  emphasis,
  strong,
  underline,
  strike,
  code,
  superscript,
  subscript,
  small
}

/// How a block sits in its measure.
///
/// Not `BlockAlign`: Flutter has a widget of that name, and a reader written
/// against both would have to say which it meant on every line.
enum BlockAlign { start, center, end, justify }

/// A run of text with the marks that apply to it, and a link if it is one.
class Run {
  const Run(this.text,
      {this.marks = const {}, this.href, this.isBreak = false});

  /// A line the author asked for, as opposed to a newline in the markup.
  ///
  /// The two are not the same thing and cannot be told apart once both are a
  /// `\n` in a string. Fic markup is full of newlines between tags — they are
  /// how it is indented — so reading those as breaks double-spaces an entire
  /// library, and reading a `<br>` as whitespace runs a poem into prose.
  const Run.lineBreak({Set<Mark> marks = const {}, String? href})
      : this('\n', marks: marks, href: href, isBreak: true);

  final String text;
  final Set<Mark> marks;
  final String? href;
  final bool isBreak;

  bool get isLink => href != null;

  Run withMark(Mark mark) =>
      Run(text, marks: {...marks, mark}, href: href, isBreak: isBreak);
  Run withHref(String? link) =>
      Run(text, marks: marks, href: link ?? href, isBreak: isBreak);

  @override
  String toString() => 'Run(${_quote(text)}'
      '${marks.isEmpty ? '' : ', ${marks.map((m) => m.name).join('+')}'}'
      '${href == null ? '' : ', -> $href'})';

  static String _quote(String s) => '"${s.replaceAll('\n', r'\n')}"';
}

/// A piece of a chapter. Sealed so a renderer cannot forget one.
sealed class Block {
  const Block();
}

class Paragraph extends Block {
  const Paragraph(this.runs, {this.align = BlockAlign.start});
  final List<Run> runs;
  final BlockAlign align;
}

class Heading extends Block {
  const Heading(this.level, this.runs, {this.align = BlockAlign.start});
  final int level;
  final List<Run> runs;
  final BlockAlign align;
}

/// Quoted matter, which fic uses for letters, texts and remembered speech.
class Quote extends Block {
  const Quote(this.children);
  final List<Block> children;
}

class BulletList extends Block {
  const BulletList(this.items, {this.ordered = false});
  final List<List<Block>> items;
  final bool ordered;
}

/// A scene break. Fic leans on these heavily and losing them loses the pacing.
class Rule extends Block {
  const Rule();
}

class Picture extends Block {
  const Picture(this.src, {this.alt});
  final String src;
  final String? alt;
}

/// Preformatted text, where the whitespace is the content.
class Preformatted extends Block {
  const Preformatted(this.text);
  final String text;
}

/// Something this model has no shape for — a table, most often.
///
/// Kept as its markup rather than dropped, so the reader can put the one
/// awkward block into a WebView instead of silently losing it or turning a
/// table into a column of fragments.
class Unsupported extends Block {
  const Unsupported(this.tag, this.html);
  final String tag;
  final String html;
}

/// A chapter, ready to lay out.
class ChapterDocument {
  const ChapterDocument(this.blocks);
  final List<Block> blocks;

  /// Whether anything in here needs the other renderer.
  bool get hasUnsupported => blocks.any((b) => b is Unsupported);
}

/// Which surface a work should be read on.
///
/// A work whose author wrote a skin is read in a WebView, because the skin is
/// the work: a chat fic, a newspaper clipping, a letter in a different hand.
/// Everything else — most of a library — is read as native text.
bool needsWebView({String? skinCss}) =>
    skinCss != null && skinCss.trim().isNotEmpty;

const Map<String, Mark> _marks = {
  'em': Mark.emphasis,
  'i': Mark.emphasis,
  'strong': Mark.strong,
  'b': Mark.strong,
  'u': Mark.underline,
  'ins': Mark.underline,
  's': Mark.strike,
  'strike': Mark.strike,
  'del': Mark.strike,
  'code': Mark.code,
  'kbd': Mark.code,
  'samp': Mark.code,
  'var': Mark.code,
  'sup': Mark.superscript,
  'sub': Mark.subscript,
  'small': Mark.small,
};

const Set<String> _blockTags = {
  'p',
  'div',
  'section',
  'article',
  'aside',
  'blockquote',
  'pre',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'figure',
  'figcaption',
  'table',
  'center',
  'address',
  'details',
  'dl',
  'dt',
  'dd',
};

/// Turn one chapter's HTML into blocks.
ChapterDocument parseChapter(String? chapterHtml) {
  final fragment = html.parseFragment(chapterHtml ?? '');
  final blocks = <Block>[];
  _collect(fragment.nodes, blocks, const Run(''), BlockAlign.start);
  return ChapterDocument(_tidy(blocks));
}

/// Gather blocks out of a list of nodes, carrying inherited marks downwards.
void _collect(
    List<dom.Node> nodes, List<Block> out, Run carried, BlockAlign align) {
  var loose = <Run>[];

  void flush() {
    final runs = _trimRuns(loose);
    if (runs.isNotEmpty) out.add(Paragraph(runs, align: align));
    loose = <Run>[];
  }

  for (final node in nodes) {
    if (node is dom.Text) {
      loose.add(Run(node.text, marks: carried.marks, href: carried.href));
      continue;
    }
    if (node is! dom.Element) continue;
    final tag = node.localName ?? '';

    if (tag == 'br') {
      loose.add(Run.lineBreak(marks: carried.marks, href: carried.href));
      continue;
    }

    if (tag == 'img') {
      /* A picture is a block even when it is written inside a sentence.
         Fic uses images as illustrations between paragraphs far more often
         than as something flowing in a line of text, and a run that is not
         text has nowhere to sit in a paragraph of runs. */
      final src = node.attributes['src']?.trim() ?? '';
      flush();
      if (src.isNotEmpty) out.add(Picture(src, alt: node.attributes['alt']));
      continue;
    }

    if (!_blockTags.contains(tag)) {
      // inline: fold its mark in and keep gathering into the same paragraph
      loose.addAll(_inline(node, carried));
      continue;
    }

    flush();
    _block(node, out, carried, align);
  }
  flush();
}

/// One block-level element.
void _block(
    dom.Element node, List<Block> out, Run carried, BlockAlign inherited) {
  final tag = node.localName ?? '';
  final align =
      _alignOf(node) ?? (tag == 'center' ? BlockAlign.center : inherited);

  /* The archive's own signposts, which are for a screen reader working its
     way down a page and not for somebody reading a chapter. "Chapter Text"
     above the first paragraph of every chapter is the app narrating its own
     markup, and the chapter's number is already in the bar at the top. */
  if (node.classes.contains('landmark')) return;

  switch (tag) {
    case 'hr':
      out.add(const Rule());

    case 'pre':
      out.add(Preformatted(node.text));

    case 'table':
      // No shape for this, and a table flattened into paragraphs is not the
      // table. Kept whole so the reader can hand this one block to a WebView.
      out.add(Unsupported('table', node.outerHtml));

    case 'blockquote':
      final inner = <Block>[];
      _collect(node.nodes, inner, carried, align);
      out.add(Quote(_tidy(inner)));

    case 'ul':
    case 'ol':
      final items = <List<Block>>[];
      for (final li in node.children.where((c) => c.localName == 'li')) {
        final inner = <Block>[];
        _collect(li.nodes, inner, carried, align);
        items.add(_tidy(inner));
      }
      if (items.isNotEmpty) out.add(BulletList(items, ordered: tag == 'ol'));

    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      final runs = _trimRuns(_inline(node, carried));
      if (runs.isNotEmpty) {
        out.add(Heading(int.parse(tag.substring(1)), runs, align: align));
      }

    default:
      // p, div, section, figure and the rest: a container of other things.
      final inner = <Block>[];
      _collect(node.nodes, inner, carried, align);
      out.addAll(inner);
  }
}

/// The runs inside an inline element, with its own mark folded in.
List<Run> _inline(dom.Element node, Run carried) {
  final tag = node.localName ?? '';
  var context = carried;

  final mark = _marks[tag];
  if (mark != null) context = context.withMark(mark);
  if (tag == 'a') {
    final href = node.attributes['href'];
    if (href != null && href.trim().isNotEmpty)
      context = context.withHref(href.trim());
  }

  final runs = <Run>[];
  for (final child in node.nodes) {
    if (child is dom.Text) {
      runs.add(Run(child.text, marks: context.marks, href: context.href));
    } else if (child is dom.Element) {
      if (child.localName == 'br') {
        runs.add(Run.lineBreak(marks: context.marks, href: context.href));
      } else {
        runs.addAll(_inline(child, context));
      }
    }
  }
  return runs;
}

BlockAlign? _alignOf(dom.Element node) {
  final attr = node.attributes['align']?.toLowerCase().trim();
  final style = node.attributes['style']?.toLowerCase() ?? '';
  final styled =
      RegExp(r'text-align\s*:\s*([a-z]+)').firstMatch(style)?.group(1);
  final name = styled ?? attr;
  return switch (name) {
    'center' || 'centre' => BlockAlign.center,
    'right' || 'end' => BlockAlign.end,
    'justify' => BlockAlign.justify,
    'left' || 'start' => BlockAlign.start,
    _ => null,
  };
}

/// Collapse runs of whitespace the way HTML does, and drop what is only space.
///
/// A newline in the source is not a line break — fic markup is full of them
/// between tags — but a `<br>` is, and it arrives here as one. So whitespace
/// collapses to a single space except where it was written as a break.
List<Run> _trimRuns(List<Run> runs) {
  final out = <Run>[];
  for (final run in runs) {
    if (run.isBreak) {
      out.add(run);
      continue;
    }
    // every other kind of whitespace is layout, and collapses to one space
    final collapsed = run.text.replaceAll(RegExp(r'\s+'), ' ');
    if (collapsed.isEmpty) continue;
    out.add(Run(collapsed, marks: run.marks, href: run.href));
  }
  // leading and trailing space belongs to the layout, not to the text
  while (out.isNotEmpty && out.first.text.trim().isEmpty) {
    out.removeAt(0);
  }
  while (out.isNotEmpty && out.last.text.trim().isEmpty) {
    out.removeLast();
  }
  if (out.isEmpty) return out;
  out[0] = Run(out.first.text.replaceFirst(RegExp(r'^[ \t]+'), ''),
      marks: out.first.marks, href: out.first.href);
  out[out.length - 1] = Run(out.last.text.replaceFirst(RegExp(r'[ \t]+$'), ''),
      marks: out.last.marks, href: out.last.href);
  return out.where((r) => r.text.isNotEmpty).toList();
}

/// Drop empty paragraphs left behind by containers that held only whitespace.
List<Block> _tidy(List<Block> blocks) =>
    blocks.where((b) => b is! Paragraph || b.runs.isNotEmpty).toList();
