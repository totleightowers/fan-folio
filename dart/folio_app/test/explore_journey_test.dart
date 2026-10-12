import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:folio_app/downloads.dart';
import 'package:folio_app/discovery_store.dart';
import 'package:folio_app/explore_screen.dart';
import 'package:folio_app/library.dart';
import 'package:folio_app/main.dart';
import 'package:folio_app/theme.dart';
import 'package:folio_app/work_screen.dart';
import 'package:folio_core/folio_core.dart' as core;
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'test_database.dart';

String listing(int page) =>
    '''<ol class="pagination"><li><a href="?page=1">1</a></li>
<li><a href="?page=2">2</a></li><li><span class="current">$page</span></li></ol>
<ol class="work index group">${List.generate(12, (i) {
      return '''
<li class="work blurb" id="work_${page * 100 + i}">
<h4 class="heading"><a href="/works/${page * 100 + i}">Story $page.$i</a>
by <a rel="author">Writer</a></h4>
<h5 class="fandoms"><a class="tag">A favourite fandom</a></h5>
<ul class="required-tags"><li><span class="rating" title="Teen And Up Audiences">Teen And Up Audiences</span></li></ul>
<ul class="tags"><li class="relationships"><a class="tag">Alex/Robin</a></li></ul>
<blockquote class="summary"><p>A quiet adventure, with a long way home.</p></blockquote>
<dl class="stats"><dd class="words">12,345</dd><dd class="chapters">3/3</dd></dl>
</li>''';
    }).join()}</ol>''';

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

  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'archive filters clear and submit above the keyboard at scale $scale',
      (tester) async {
        tester.view.physicalSize = const Size(390, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        core.ArchiveSearch? chosen;
        await tester.pumpWidget(
          MaterialApp(
            theme: themeFor(Ground.dark, Brightness.dark),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: Scaffold(
              body: Builder(
                builder: (context) => TextButton(
                  child: const Text('Open filters'),
                  onPressed: () async {
                    chosen = await showModalBottomSheet<core.ArchiveSearch>(
                      context: context,
                      isScrollControlled: true,
                      builder: (_) => const ArchiveSearchSheet(
                        search: core.ArchiveSearch(
                          fields: {'complete': 'T', 'rating_ids': '13'},
                        ),
                      ),
                    );
                  },
                ),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open filters'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Clear'));
        await tester.pumpAndSettle();
        final title = find.byWidgetPredicate(
          (w) => w is TextField && w.decoration?.labelText == 'Title',
        );
        await tester.enterText(title, 'A title');
        tester.view.viewInsets = const FakeViewPadding(bottom: 280);
        await tester.pumpAndSettle();
        expect(
          tester.getBottomLeft(find.text('Show results')).dy,
          lessThan(620),
        );
        await tester.tap(find.text('Show results'));
        await tester.pumpAndSettle();
        expect(chosen?.fields['title'], 'A title');
        expect(chosen?.fields['complete'], '');
        expect(chosen?.fields['rating_ids'], '');
        expect(tester.takeException(), isNull);
      },
    );
  }

  for (final width in [390.0, 1100.0]) {
    testWidgets(
      'archive browsing retains results, position and details across sections at $width',
      (tester) async {
        tester.view.physicalSize = Size(width, 900);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        late Directory scratch;
        late Library library;
        await tester.runAsync(() async {
          scratch = await Directory.systemTemp.createTemp('folio-explore');
          library = await Library.create('${scratch.path}/library.db');
        });
        final requests = <Uri>[];
        var clock = DateTime(2026);
        final downloads = Downloads(
          library: library,
          pacerFactory: (checkpoint) => core.Pacer(
            now: () => clock,
            sleep: (d) async {
              clock = clock.add(d);
            },
            checkpoint: checkpoint,
          ),
          clientFactory: (pacer) => core.ArchiveClient(
            pacer: pacer,
            http_: MockClient((request) async {
              requests.add(request.url);
              final page = int.parse(
                request.url.queryParameters['page'] ?? '1',
              );
              return http.Response(
                listing(page),
                200,
                headers: {'content-type': 'text/html; charset=utf-8'},
              );
            }),
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
        Future<void> settle() async {
          for (var i = 0; i < 25; i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 10)),
            );
            await tester.pump(const Duration(milliseconds: 30));
          }
        }

        Future<void> screenshot(String name) async {
          await tester.runAsync(() async {
            final image =
                await (boundary.currentContext!.findRenderObject()!
                        as RenderRepaintBoundary)
                    .toImage();
            final png = await image.toByteData(format: ui.ImageByteFormat.png);
            await Directory('preview-screenshots').create();
            await File('preview-screenshots/$name-${width.toInt()}.png')
                .writeAsBytes(png!.buffer.asUint8List());
            image.dispose();
          });
        }

        await settle();
        await tester.tap(find.text('Explore').last);
        await settle();
        await tester.enterText(find.byType(TextField), 'quiet adventure');
        expect(requests, isEmpty, reason: 'typing must not call AO3');
        await tester.tap(find.byTooltip('Search AO3'));
        await settle();
        expect(requests, hasLength(1));
        expect(
          requests.single.queryParameters['work_search[query]'],
          'quiet adventure',
        );
        expect(find.text('Story 1.0'), findsOneWidget);
        await screenshot('explore');
        final scrollable = find.descendant(
          of: find.descendant(
            of: find.byType(ExploreScreen),
            matching: find.byType(ListView),
          ),
          matching: find.byType(Scrollable),
        );
        await tester.drag(scrollable, const Offset(0, -450));
        await tester.pumpAndSettle();
        final offset = tester
            .state<ScrollableState>(scrollable)
            .position
            .pixels;
        expect(offset, greaterThan(0));
        await tester.tap(find.text('Library').last);
        await settle();
        await tester.tap(find.text('Explore').last);
        await settle();
        expect(requests, hasLength(1));
        expect(
          tester.state<ScrollableState>(scrollable).position.pixels,
          offset,
        );
        tester.state<ScrollableState>(scrollable).position.jumpTo(0);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Story 1.0'));
        await settle();
        expect(find.byType(WorkScreen), findsOneWidget);
        expect(find.text('Read now'), findsOneWidget);
        expect(find.text('Download for later'), findsOneWidget);
        expect(
          find.byType(width >= 720 ? NavigationRail : NavigationBar),
          findsOneWidget,
        );
        await screenshot('discovered-work');
        await tester.tap(find.byTooltip('Keep for later'));
        await settle();
        await tester.runAsync(() async {
          expect((await library.work('100'))?.markedLater, isTrue);
          expect(await library.chapters('100'), isEmpty);
        });
        await tester.tap(find.text('Home').last);
        await settle();
        await tester.tap(find.text('Explore').last);
        await settle();
        expect(
          find.byType(WorkScreen),
          findsOneWidget,
          reason: 'switching tabs retains the work route',
        );
        await tester.tap(find.byTooltip('Back'));
        await settle();
        expect(find.text('Story 1.0'), findsOneWidget);
        expect(requests, hasLength(1));
        await tester.tap(find.byTooltip('Save search'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Save'));
        await settle();
        await tester.runAsync(() async {
          expect(
            (await DiscoveryStore(library).all()).single.search.fields['query'],
            'quiet adventure',
          );
        });
        await tester.scrollUntilVisible(
          find.text('Next'),
          500,
          scrollable: scrollable,
        );
        await tester.tap(find.text('Next'));
        await settle();
        expect(requests, hasLength(2));
        expect(requests.last.queryParameters['page'], '2');
        expect(find.text('Story 2.0'), findsOneWidget);
        await tester.tap(find.byTooltip('Saved searches'));
        await settle();
        await tester.tap(find.byTooltip('Saved search actions'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Check for new results'));
        await settle();
        expect(requests, hasLength(3));
        expect(requests.last.queryParameters['page'], '1');
        expect(
          find.text('0 new results on the first page since the last check.'),
          findsOneWidget,
        );
        // Blocking an author from a nested route hides their archive results
        // on return, without sending another archive request.
        await tester.tap(find.text('Story 1.0'));
        await settle();
        await tester.runAsync(
          () => library.setBlocked('Writer', blocked: true),
        );
        await tester.tap(find.byTooltip('Back'));
        await settle();
        expect(
          find.text('Authors on your block list are hidden.'),
          findsOneWidget,
        );
        expect(find.text('Story 1.0'), findsNothing);
        expect(requests, hasLength(3));
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
