import 'dart:convert';
import 'dart:io';

import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// The native reader must not lose a word the WebView showed.
///
/// 2.x lays most works out as native text. The risk in that is not that it
/// looks different — that is the point — but that it quietly drops something:
/// a paragraph inside a div nobody expected, the contents of a tag the new
/// renderer has no case for. A reader who finds out a scene is missing finds
/// out by reaching the next one.
///
/// So the words come from the implementation that has been showing them for
/// weeks, and the document model has to produce the same ones in the same
/// order. Layout may differ between the two readers. The text may not.
List<String> _words(ChapterDocument doc) => _split(_text(doc.blocks));

/// Words, not fragments.
///
/// Counting per run splits a word wherever a mark does: "sentence" and "."
/// are two runs of one word, and an italicised syllable mid-word is three.
/// The text is joined first and split afterwards, the way a reader sees it.
List<String> _split(String text) =>
    text.split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();

String _text(List<Block> blocks) {
  final out = StringBuffer();
  for (final block in blocks) {
    switch (block) {
      case Paragraph(:final runs):
      case Heading(:final runs):
        for (final run in runs) {
          out.write(run.text);
        }
      case Quote(:final children):
        out.write(_text(children));
      case BulletList(:final items):
        for (final item in items) {
          out.write(_text(item));
          out.write('\n');
        }
      case Preformatted(:final text):
        out.write(text);
      case Picture():
      case Rule():
        break;
      case Unsupported(:final html):
        // kept for the other renderer; its words are still in the work
        out.write(_text(parseChapter(html).blocks));
    }
    out.write('\n');
  }
  return out.toString();
}

void main() {
  final fixture = jsonDecode(
      File('test/conformance/chapters.json').readAsStringSync()) as Map<String, Object?>;

  group('a real chapter keeps every word', () {
    for (final entry in (fixture['chapters'] as List).cast<Map<String, Object?>>()) {
      test('chapter ${entry['number']}', () {
        final expected = (entry['words'] as List).cast<String>();
        final actual = _words(parseChapter(entry['html'] as String));
        expect(actual.length, expected.length,
            reason: 'the native reader lost or invented text');
        expect(actual, expected);
      });
    }
  });

  group('and so does every shape fic is written in', () {
    for (final entry in (fixture['shapes'] as List).cast<Map<String, Object?>>()) {
      final html = entry['html'] as String;
      test(html.length > 46 ? '${html.substring(0, 46)}…' : html, () {
        expect(_words(parseChapter(html)), (entry['words'] as List).cast<String>());
      });
    }
  });
}
