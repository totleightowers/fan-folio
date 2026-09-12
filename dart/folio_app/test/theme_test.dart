import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:folio_core/folio_core.dart';
import 'package:folio_app/theme.dart';

void main() {
  test('the two grounds are the same vocabulary, said twice', () {
    /* A theme restates the words; it does not invent new ones. Warm neutrals
       hold their warmth in the dark, because a grey inversion of a paper app
       reads as a different, colder product wearing the same layout. */
    expect(Ground.light.paper, isNot(Ground.dark.paper));
    expect(Ground.light.ink, isNot(Ground.dark.ink));
    for (final g in [Ground.light, Ground.dark, Ground.sepia, Ground.black]) {
      expect(
        g.paper,
        isNot(g.surface),
        reason: 'a card has to sit on something',
      );
      expect(
        g.surface,
        isNot(g.sunken),
        reason: 'a well has to be cut into something',
      );
      expect(
        {g.ink, g.inkMid, g.inkMute, g.inkFaint}.length,
        4,
        reason: 'four weights of ink, not one repeated',
      );
    }
  });

  test('sepia is its own paper, not a filter over the day one', () {
    /* The reason to offer sepia is that black on white at full contrast is
       tiring to read for an hour. Cream paper with the day theme's ink is the
       same contrast with a tint on it, which fixes nothing. */
    expect(Ground.sepia.paper, isNot(Ground.light.paper));
    expect(Ground.sepia.ink, isNot(Ground.light.ink));
  });

  test('black is black, since that is the only reason to have it', () {
    /* On an OLED screen a black pixel is a pixel that is off. A dark grey is
       not, and somebody choosing this over Night is choosing exactly that. */
    expect(Ground.black.paper, const Color(0xFF000000));
    expect(Ground.black.paper, isNot(Ground.dark.paper));
  });

  test('sepia is a light theme and black is a dark one', () {
    /* Material paints its own dialogs, sheets and sliders from this. Getting
       it backwards gives a reader white controls on black paper. */
    for (final system in Brightness.values) {
      expect(brightnessOf(ReadingTheme.sepia, system), Brightness.light);
      expect(brightnessOf(ReadingTheme.black, system), Brightness.dark);
      expect(brightnessOf(ReadingTheme.system, system), system);
    }
  });

  test('the reader carries its own light, and auto follows the device', () {
    expect(readingGround(ReadingTheme.system, Brightness.dark), Ground.dark);
    expect(readingGround(ReadingTheme.system, Brightness.light), Ground.light);
    // and a chosen paper is that paper whatever the device is doing
    expect(readingGround(ReadingTheme.sepia, Brightness.dark), Ground.sepia);
    expect(readingGround(ReadingTheme.light, Brightness.dark), Ground.light);
  });

  test('a title is set in the face the library is read in', () {
    final theme = themeFor(Ground.light, Brightness.light);
    expect(theme.appBarTheme.titleTextStyle?.fontFamily, titleFace);
  });

  test('a shelf card is recognisable by colour, not only by reading it', () {
    /* Fic has no covers. Without a spine a shelf is a row of paragraphs and
       finding a work by eye means reading every title on it. */
    expect(spineRgb('BTS'), isNot(spineRgb('EXO')));
    expect(spineRgb('BTS'), spineRgb('BTS'));
  });
}
