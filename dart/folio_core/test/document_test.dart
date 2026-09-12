import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

ChapterDocument doc(String? html) => parseChapter(html);
String textOf(List<Run> runs) => runs.map((r) => r.text).join();

void main() {
  test('a chapter is paragraphs, not one long string', () {
    final d = doc('<p>The first.</p><p>The second.</p>');
    expect(d.blocks.length, 2);
    expect(textOf((d.blocks[0] as Paragraph).runs), 'The first.');
    expect(textOf((d.blocks[1] as Paragraph).runs), 'The second.');
  });

  test('emphasis survives, because it is the author speaking', () {
    final d = doc('<p>She was <em>certain</em> of it.</p>');
    final runs = (d.blocks.single as Paragraph).runs;
    expect(textOf(runs), 'She was certain of it.');
    expect(runs.firstWhere((r) => r.text == 'certain').marks, {Mark.emphasis});
    expect(runs.first.marks, isEmpty);
  });

  test('marks nest rather than replacing one another', () {
    final d = doc('<p><strong>very <em>very</em> sure</strong></p>');
    final runs = (d.blocks.single as Paragraph).runs;
    final inner =
        runs.firstWhere((r) => r.text.trim() == 'very' && r.marks.length > 1);
    expect(inner.marks, {Mark.strong, Mark.emphasis});
  });

  test('a line break is a break; a newline in the markup is not', () {
    /* Fic markup is full of newlines between tags. Treating those as breaks
       would double-space an entire library. */
    final d = doc('<p>First line<br>Second line</p>');
    expect(
        textOf((d.blocks.single as Paragraph).runs), 'First line\nSecond line');

    final wrapped = doc('<p>One\n   two\n   three</p>');
    expect(textOf((wrapped.blocks.single as Paragraph).runs), 'One two three');
  });

  test('a scene break is kept, because it is the pacing', () {
    final d = doc('<p>Before.</p><hr><p>After.</p>');
    expect(d.blocks[1], isA<Rule>());
  });

  test('centring is deliberate and is carried through', () {
    for (final markup in [
      '<p align="center">A letter.</p>',
      '<p style="text-align: center;">A letter.</p>',
      '<center><p>A letter.</p></center>',
      '<div style="text-align:center"><p>A letter.</p></div>',
    ]) {
      final block = doc(markup).blocks.single as Paragraph;
      expect(block.align, BlockAlign.center, reason: markup);
      expect(textOf(block.runs), 'A letter.');
    }
  });

  test('a quotation is a quotation and keeps its paragraphs', () {
    final d =
        doc('<blockquote><p>Dear you,</p><p>I am sorry.</p></blockquote>');
    final quote = d.blocks.single as Quote;
    expect(quote.children.length, 2);
    expect(textOf((quote.children.first as Paragraph).runs), 'Dear you,');
  });

  test('lists keep their items and know whether they are numbered', () {
    final d = doc('<ol><li>One</li><li>Two</li></ol>');
    final list = d.blocks.single as BulletList;
    expect(list.ordered, isTrue);
    expect(list.items.length, 2);
    expect(textOf((list.items[1].single as Paragraph).runs), 'Two');
  });

  test('a link keeps where it goes', () {
    final d = doc('<p>See <a href="https://example.test/x">this</a>.</p>');
    final runs = (d.blocks.single as Paragraph).runs;
    final link = runs.firstWhere((r) => r.isLink);
    expect(link.text, 'this');
    expect(link.href, 'https://example.test/x');
    expect(runs.first.isLink, isFalse);
  });

  test('an image becomes a block of its own', () {
    final d = doc('<p>Look:</p><p><img src="/img/abc" alt="a drawing"></p>');
    final picture = d.blocks.whereType<Picture>().single;
    expect(picture.src, '/img/abc');
    expect(picture.alt, 'a drawing');
  });

  test('preformatted text keeps the whitespace that is its content', () {
    final d = doc('<pre>  line one\n  line two</pre>');
    expect((d.blocks.single as Preformatted).text, '  line one\n  line two');
  });

  test('a table is kept whole rather than flattened or lost', () {
    /* There is no shape for a table here, and a table turned into a column of
       fragments is not the table. Kept as markup so the reader can hand this
       one block to a WebView. */
    final d = doc('<p>Before.</p><table><tr><td>a</td><td>b</td></tr></table>');
    final odd = d.blocks.whereType<Unsupported>().single;
    expect(odd.tag, 'table');
    expect(odd.html, contains('<td>a</td>'));
    expect(d.hasUnsupported, isTrue);
  });

  test('markup nobody closed still reads as a chapter', () {
    /* Fic markup is written by hand over twenty years. A parser that gives up
       on the first unclosed tag would lose the rest of the work. */
    final d = doc('<p>One<p>Two<em>three</p>');
    expect(d.blocks.whereType<Paragraph>().length, greaterThanOrEqualTo(2));
    expect(d.blocks.map((b) => b is Paragraph ? textOf(b.runs) : '').join(' '),
        contains('Two'));
  });

  test('nothing but whitespace is nothing, not an empty paragraph', () {
    expect(doc('<p>  </p><div>\n</div>').blocks, isEmpty);
    expect(doc('').blocks, isEmpty);
    expect(doc(null).blocks, isEmpty);
  });

  group('which surface a work is read on', () {
    test('a work with an author skin goes to the WebView', () {
      expect(needsWebView(skinCss: '#workskin p { color: red }'), isTrue);
    });
    test('and everything else is read as native text', () {
      expect(needsWebView(skinCss: null), isFalse);
      expect(needsWebView(skinCss: ''), isFalse);
      expect(needsWebView(skinCss: '   '), isFalse,
          reason: 'a column of whitespace is not a skin');
    });
  });
}
