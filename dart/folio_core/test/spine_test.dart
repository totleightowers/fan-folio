import 'package:folio_core/folio_core.dart';
import 'package:test/test.dart';

/// Fic has no covers, so a shelf is a shelf of text and finding one by eye
/// means reading every title on it. The spine colour is what makes a shelf
/// scannable, and the same fandom has to be the same colour wherever it
/// appears — including across the two versions of this app, or a library
/// somebody knows by sight becomes one they do not.
void main() {
  test('the same name is always the same colour', () {
    expect(spineHsl('BTS').hue, spineHsl('BTS').hue);
    expect(spineRgb('Les Misérables'), spineRgb('Les Misérables'));
  });

  test('different names are usually different colours', () {
    final hues = [
      'BTS',
      'EXO',
      'Les Misérables',
      'The Magnus Archives',
      'Yuri!!! on Ice'
    ].map((f) => spineHsl(f).hue).toSet();
    expect(hues.length, greaterThan(3),
        reason: 'a shelf of one colour is no key at all');
  });

  test('it matches the hash 1.x uses', () {
    /* Computed by the JavaScript: hash = hash * 31 + charCode, unsigned 32-bit,
       modulo 360. A different hash would be a different-coloured library —
       a small thing that would feel like a broken one. */
    int jsHash(String seed) {
      var hash = 0;
      for (final unit in seed.codeUnits) {
        hash = (hash * 31 + unit) & 0xFFFFFFFF;
      }
      return hash % 360;
    }

    for (final seed in [
      'BTS',
      'EXO',
      'a',
      '',
      'Harry Potter - J. K. Rowling',
      'ünicode'
    ]) {
      expect(spineHsl(seed).hue, jsHash(seed), reason: seed);
    }
  });

  test('a work with no fandom still gets a spine', () {
    expect(spineHsl(null).hue, isA<int>());
    expect(spineRgb(null), isA<int>());
  });

  test('the colour is a real colour, in range', () {
    for (final seed in ['BTS', 'EXO', null, '']) {
      final rgb = spineRgb(seed);
      expect(rgb, inInclusiveRange(0, 0xFFFFFF));
    }
  });
}
