import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:folio_app/library.dart';
import 'package:folio_app/theme.dart';
import 'package:folio_app/work_screen.dart';

import 'test_database.dart';

void main() {
  setUpAll(prepareTestDatabase);
  for (final scale in [1.0, 2.0]) {
    testWidgets('work details keep readable controls at ${scale}x text', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(390, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final semantics = tester.ensureSemantics();
      addTearDown(semantics.dispose);
      late Directory scratch;
      late Library library;
      await tester.runAsync(() async {
        scratch = await Directory.systemTemp.createTemp('folio-accessibility');
        library = await Library.create('${scratch.path}/library.db');
        await library.db.insert('works', {
          'work_id': '1',
          'title': 'An illustrated story',
          'authors': '["Fixture author"]',
          'summary': 'A story to read offline.',
          'has_text': 1,
          'rating': 'General Audiences',
          'words': 25859,
          'chapter_count': 1,
        });
        await library.db.insert('chapters', {
          'work_id': '1',
          'number': 1,
          'html': '<p>Story.</p>',
        });
        await library.db.insert('tags', {
          'work_id': '1',
          'kind': 'relationship',
          'name': 'A long relationship name that must wrap at large text sizes',
        });
      });
      var authorOpened = false;
      await tester.pumpWidget(
        MaterialApp(
          theme: themeFor(Ground.dark, Brightness.dark),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: WorkScreen(
            library: library,
            workId: '1',
            onRead: (_, __, ___) {},
            onPerson: (_) => authorOpened = true,
            onNarrow: (_, __) {},
          ),
        ),
      );
      for (var i = 0; i < 20; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 15)),
        );
        await tester.pump();
        if (find.text('Fixture author').evaluate().isNotEmpty) break;
      }
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final author = find.widgetWithText(TextButton, 'Fixture author');
      expect(tester.getSize(author).height, greaterThanOrEqualTo(48));
      await tester.tap(author);
      expect(authorOpened, isTrue);
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      await tester.scrollUntilVisible(
        find.text(
          'A long relationship name that must wrap at large text sizes',
        ),
        100,
      );
      expect(tester.takeException(), isNull);
      expect(
        tester
            .getSize(
              find.widgetWithText(
                TextButton,
                'A long relationship name that must wrap at large text sizes',
              ),
            )
            .height,
        greaterThanOrEqualTo(48),
      );
      await tester.pumpWidget(const SizedBox());
      await tester.runAsync(() async {
        await library.db.close();
        await scratch.delete(recursive: true);
      });
    });
  }
}
