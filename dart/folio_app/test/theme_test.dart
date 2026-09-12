import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:folio_app/theme.dart';

void main() {
  test('the two grounds are the same vocabulary, said twice', () {
    /* A theme restates the words; it does not invent new ones. Warm neutrals
       hold their warmth in the dark, because a grey inversion of a paper app
       reads as a different, colder product wearing the same layout. */
    expect(Ground.light.paper, isNot(Ground.dark.paper));
    expect(Ground.light.ink, isNot(Ground.dark.ink));
    for (final g in [Ground.light, Ground.dark]) {
      expect(g.paper, isNot(g.surface), reason: 'a card has to sit on something');
      expect(g.surface, isNot(g.sunken), reason: 'a well has to be cut into something');
      expect(
        {g.ink, g.inkMid, g.inkMute, g.inkFaint}.length,
        4,
        reason: 'four weights of ink, not one repeated',
      );
    }
  });

  test('a title is set in the face the library is read in', () {
    final theme = themeFor(Ground.light, Brightness.light);
    expect(theme.appBarTheme.titleTextStyle?.fontFamily, titleFace);
  });
}
