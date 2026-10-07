import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:folio_app/library.dart';
import 'package:folio_app/return_to_story.dart';
import 'package:folio_app/theme.dart';
import 'package:folio_app/work_card.dart';

void main() {
  const work = WorkRow(
    workId: 'fixture',
    title: 'A saved story',
    authors: ['Fixture author'],
    rating: 'Teen And Up Audiences',
    relationship: 'A/B',
    hasText: true,
  );

  for (final width in [360.0, 1100.0]) {
    testWidgets('the whole return pill is tappable at width $width', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      var opened = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: themeFor(Ground.dark, Brightness.dark),
          home: Scaffold(
            bottomNavigationBar: ReturnToStory(
              work: work,
              chapter: 3,
              onResume: () => opened++,
            ),
          ),
        ),
      );
      await tester.tap(find.text('A saved story'));
      await tester.tap(find.text('Return to the story · Chapter 3'));
      await tester.tap(find.byIcon(Icons.play_arrow_outlined));
      expect(opened, 3);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'a library row opens from the title or body and shows its rating and relationship',
    (tester) async {
      var opened = 0;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkRowTile(work: work, onTap: () => opened++),
          ),
        ),
      );
      await tester.tap(find.text('A saved story'));
      await tester.tap(find.textContaining('Teen And Up Audiences'));
      expect(opened, 2);
      expect(find.textContaining('A/B'), findsOneWidget);
    },
  );
}
