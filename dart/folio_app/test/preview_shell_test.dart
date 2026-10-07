import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:folio_app/downloads.dart';
import 'package:folio_app/library.dart';
import 'package:folio_app/main.dart';
import 'package:folio_app/return_to_story.dart';
import 'package:folio_app/theme.dart';
import 'package:folio_core/folio_core.dart' as core;
import 'package:http/testing.dart';

import 'test_database.dart';

void main() {
  setUpAll(() async {
    prepareTestDatabase();
    for (final (family, path) in [
      ('Ahem', 'fonts/AtkinsonHyperlegible-Regular.ttf'),
      ('Atkinson Hyperlegible', 'fonts/AtkinsonHyperlegible-Regular.ttf'),
      ('Literata', 'fonts/Literata.ttf'),
      ('MaterialIcons', 'fonts/MaterialIcons-Regular.otf'),
    ]) {
      await (FontLoader(family)..addFont(rootBundle.load(path))).load();
    }
  });

  for (final width in [390.0, 1100.0]) {
    testWidgets(
      'preview shell adapts and keeps the return pill across tabs at $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        late Directory scratch;
        late Library library;
        await tester.runAsync(() async {
          scratch = await Directory.systemTemp.createTemp('folio-shell');
          library = await Library.create('${scratch.path}/library.db');
          await library.db.insert('works', {
            'work_id': '1',
            'title': 'The next chapter',
            'authors': '["Fixture author"]',
            'summary': 'An offline story for the preview.',
            'has_text': 1,
            'chapter_count': 3,
            'rating': 'General Audiences',
          });
          await library.db.insert('chapters', {
            'work_id': '1',
            'number': 1,
            'html': '<p>Here is the story.</p>',
          });
          await library.opened('1');
          await library.savePlace('1', 1, 240);
        });
        final downloads = Downloads(
          library: library,
          clientFactory: (pacer) => core.ArchiveClient(
            pacer: pacer,
            http_: MockClient((_) async => fail('shell contacted the archive')),
          ),
        );
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: themeFor(Ground.dark, Brightness.dark),
              home: Shell(initialLibrary: library, initialDownloads: downloads),
            ),
          ),
        );
        Future<void> settleDatabase() async {
          for (var i = 0; i < 30; i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 10)),
            );
            await tester.pump(const Duration(milliseconds: 20));
          }
        }

        await settleDatabase();
        expect(find.byType(ReturnToStory), findsOneWidget);
        expect(
          find.byType(width >= 720 ? NavigationRail : NavigationBar),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage();
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory('preview-screenshots').create();
          await File('preview-screenshots/home-${width.toInt()}.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
        await tester.tap(find.text('Library').last);
        await settleDatabase();
        expect(find.byType(ReturnToStory), findsOneWidget);
        await tester.tap(find.text('Downloads').last);
        await settleDatabase();
        expect(find.textContaining('Nothing in the queue'), findsOneWidget);
        expect(find.byType(ReturnToStory), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(() async {
          await downloads.flush();
          await library.close();
          await scratch.delete(recursive: true);
        });
      },
    );
  }
}
