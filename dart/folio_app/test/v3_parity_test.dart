import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:folio_core/folio_core.dart' as core;
import 'package:folio_app/filter_sheet.dart';
import 'package:folio_app/library.dart';
import 'package:folio_app/store.dart';
import 'package:folio_app/versions_screen.dart';
import 'package:folio_app/work_card.dart';

import 'test_database.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(prepareTestDatabase);
  late Directory dir;
  late Library library;
  setUp(() async {
    dir = await Directory.systemTemp.createTemp('folio-v3-parity-');
    library = await Library.create('${dir.path}/library.db');
    await library.db.execute(
      "INSERT INTO works(work_id,title,authors,rating,visits,chapter_count,source,source_file) VALUES ('1','Earlier story','[\"Writer\"]','Explicit',4,1,'epub','story.epub')",
    );
    await library.db.execute(
      "INSERT INTO tags(work_id,kind,name) VALUES ('1','relationship','Alpha/Beta')",
    );
    await library.db.execute(
      "INSERT INTO chapters(work_id,number,html,text) VALUES('1',1,'<p>Original words</p>','Original words')",
    );
  });
  tearDown(() async {
    await library.close();
    await dir.delete(recursive: true);
  });

  test(
    'v3 imported metadata and combined visits survive opening and refetch',
    () async {
      await library.opened('1');
      await library.savePlace('1', 1, 42);
      await library.savePlace('1', 1, 84);
      final work = (await library.work('1'))!;
      expect(work.hasText, isTrue);
      expect(work.relationship, 'Alpha/Beta');
      expect(work.visitLabel, '5 visits · 4 AO3 + 1 Fan Folio');
      expect((await library.works()).single.relationship, 'Alpha/Beta');
      await library.finish('1');
      await library.restart('1');
      expect((await library.placeIn('1'))!.completedBefore, isTrue);
      expect(await library.count({'state': 'reading'}), 1);
      expect(await library.count({'state': 'finished'}), 1);
    },
  );

  testWidgets(
    'earlier chapter and skin copies remain reachable without moving current place',
    (tester) async {
      await library.db.execute(
        "UPDATE works SET skin_css='p {color: red}' WHERE work_id='1'",
      );
      await library.savePlace('1', 1, 84);
      await LibraryStore(library.db).save(
        const core.StoredWork(
          workId: '1',
          authors: ['Writer'],
          tags: {},
          title: 'Earlier story',
          skinCss: 'p {color: blue}',
          chapters: [
            core.StoredChapter(
              number: 1,
              html: '<p>Revised words</p>',
              text: 'Revised words',
              words: 2,
            ),
          ],
        ),
      );
      expect(
        (await library.db.query('skin_versions')).single['skin_css'],
        'p {color: red}',
      );
      await tester.pumpWidget(
        MaterialApp(
          home: VersionsScreen(
            library: library,
            work: (await library.work('1'))!,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Work skin'), findsOneWidget);
      await tester.tap(find.byTooltip('Compare chapter 1'));
      await tester.pumpAndSettle();

      expect(find.text('Original words'), findsOneWidget);
      expect(find.text('Revised words'), findsOneWidget);
      expect((await library.placeIn('1'))!.offset, 84);
      expect(await library.db.query('reading_visits'), isEmpty);
    },
  );

  testWidgets('v3 filters combine OTP with downloaded and most read', (
    tester,
  ) async {
    Map<String, Object?>? chosen;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                chosen = await showModalBottomSheet<Map<String, Object?>>(
                  context: context,
                  isScrollControlled: true,
                  builder: (_) => FilterSheet(library: library, view: const {}),
                );
              },
              child: const Text('Open filters'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open filters'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Recently added'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Most read').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('All availability'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Downloaded').last);
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('OTP only'));
    await tester.tap(find.text('OTP only'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show 1'));
    await tester.pumpAndSettle();
    expect(chosen, containsPair('otp', '1'));
    expect(chosen, containsPair('availability', 'held'));
    expect(chosen, containsPair('sort', 'visits'));
  });

  testWidgets('cards expose metadata and full descriptions at large text', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const work = WorkRow(
      workId: '1',
      title: 'Story',
      authors: ['Writer'],
      rating: 'Explicit',
      relationship: 'Alpha/Beta',
      summary: 'Full unabridged description',
      hasText: true,
    );
    var opened = false;
    await tester.pumpWidget(
      MaterialApp(
        home: MediaQuery(
          data: const MediaQueryData(textScaler: TextScaler.linear(2)),
          child: Scaffold(
            body: ListView(
              children: [
                Shelf(
                  title: 'Continue reading',
                  works: const [work],
                  total: 1,
                  onOpen: (_) => opened = true,
                ),
                WorkRowTile(work: work, onTap: () => opened = true),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Explicit'), findsOneWidget);
    expect(find.text('Alpha/Beta'), findsOneWidget);
    expect(find.text('Full unabridged description'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('Story').first);
    expect(opened, isTrue);
  });
}
