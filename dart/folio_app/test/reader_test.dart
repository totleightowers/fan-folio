import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:folio_app/reader.dart';
import 'package:folio_core/folio_core.dart' as core;

/// What folio_core cannot check: that the blocks reach the screen.
///
/// The document model is tested against the words of real chapters, so the
/// question left for here is whether anything is painted at all, and whether a
/// mark survives the trip from model to TextStyle.
Widget wrap(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('a chapter is laid out as text, paragraph by paragraph', (tester) async {
    await tester.pumpWidget(wrap(ChapterView(
      document: core.parseChapter('<p>The first.</p><p>The second.</p>'),
      settings: const ReadingSettings(),
    )));

    expect(find.textContaining('The first.', findRichText: true), findsOneWidget);
    expect(find.textContaining('The second.', findRichText: true), findsOneWidget);
  });

  testWidgets('emphasis arrives as italics, not as asterisks', (tester) async {
    await tester.pumpWidget(wrap(ChapterView(
      document: core.parseChapter('<p>She was <em>certain</em>.</p>'),
      settings: const ReadingSettings(),
    )));

    final rich = tester.widget<RichText>(find.byType(RichText).first);
    final spans = <InlineSpan>[];
    rich.text.visitChildren((span) {
      spans.add(span);
      return true;
    });
    final italic = spans.whereType<TextSpan>().where(
      (s) => s.style?.fontStyle == FontStyle.italic,
    );
    expect(italic, isNotEmpty, reason: 'the author emphasised a word and it was lost');
    expect(italic.first.text, 'certain');
  });

  testWidgets('a scene break is drawn, because it is the pacing', (tester) async {
    await tester.pumpWidget(wrap(ChapterView(
      document: core.parseChapter('<p>Before.</p><hr><p>After.</p>'),
      settings: const ReadingSettings(),
    )));
    expect(find.byType(Divider), findsOneWidget);
  });

  testWidgets('a table says so rather than being flattened or dropped', (tester) async {
    await tester.pumpWidget(wrap(ChapterView(
      document: core.parseChapter('<table><tr><td>a</td></tr></table>'),
      settings: const ReadingSettings(),
    )));
    expect(find.textContaining('table', findRichText: true), findsOneWidget);
  });
}
