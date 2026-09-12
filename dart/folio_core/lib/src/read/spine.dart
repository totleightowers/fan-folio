/// The colour a work is recognised by.
///
/// Fic has no covers. A shelf of works is therefore a shelf of text, and
/// finding one by eye means reading every title on it — so each card carries a
/// coloured spine derived from its fandom, and the same fandom is the same
/// colour wherever it appears. The row of fandom chips above the shelves
/// becomes a key to them: the blue pill and the blue spines are the same thing
/// said twice.
///
/// Ported from 1.x exactly, hash and all, so a library looks the same in both
/// versions. A different hash would be a different-coloured library, which is
/// a small thing that would feel like a broken one.
library;

import 'dart:math' as math;

/// Hue, saturation and lightness for a seed — usually a fandom, falling back
/// to the title so a work with no fandom still has a spine of its own.
({int hue, double saturation, double lightness}) spineHsl(String? seed) {
  var hash = 0;
  for (final unit in (seed ?? '').codeUnits) {
    // 32-bit unsigned, the way the JavaScript does it: >>> 0 there, a mask here
    hash = (hash * 31 + unit) & 0xFFFFFFFF;
  }
  return (hue: hash % 360, saturation: 0.55, lightness: 0.52);
}

/// The same colour as a 24-bit RGB value, for a toolkit that wants one.
int spineRgb(String? seed) {
  final hsl = spineHsl(seed);
  return _hslToRgb(hsl.hue / 360, hsl.saturation, hsl.lightness);
}

int _hslToRgb(double h, double s, double l) {
  double channel(double n) {
    final k = (n + h * 12) % 12;
    final a = s * (l < 0.5 ? l : 1 - l);
    return l - a * math.max(-1, math.min(math.min(k - 3, 9 - k), 1));
  }

  int byte(double v) => (v.clamp(0, 1) * 255).round();
  return (byte(channel(0)) << 16) | (byte(channel(8)) << 8) | byte(channel(4));
}
