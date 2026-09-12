import 'package:flutter/material.dart';

/// The vocabulary 1.x arrived at, said in Dart.
///
/// Three grounds — the page, a thing resting on it, a well cut into it — and
/// four weights of ink. The app had a background and a pane once, and two
/// greys, so a field and a card and a sheet were the same paper at different
/// sizes and a byline and a timestamp were the same colour. Depth and weight
/// are what the eye sorts a screen by before it reads a word.
class Ground {
  const Ground({
    required this.paper,
    required this.surface,
    required this.sunken,
    required this.line,
    required this.lineSoft,
    required this.ink,
    required this.inkMid,
    required this.inkMute,
    required this.inkFaint,
    required this.accent,
    required this.onAccent,
  });

  final Color paper;
  final Color surface;
  final Color sunken;
  final Color line;
  final Color lineSoft;
  final Color ink;
  final Color inkMid;
  final Color inkMute;
  final Color inkFaint;
  final Color accent;
  final Color onAccent;

  static const Ground light = Ground(
    paper: Color(0xFFFBF9F5),
    surface: Color(0xFFFFFFFF),
    sunken: Color(0xFFF1ECE2),
    line: Color(0xFFE3DED4),
    lineSoft: Color(0xFFEFEAE1),
    ink: Color(0xFF1B1A17),
    inkMid: Color(0xFF4A453F),
    inkMute: Color(0xFF6B6560),
    inkFaint: Color(0xFF968F86),
    accent: Color(0xFF8C3B2E),
    onAccent: Color(0xFFFFFFFF),
  );

  /// Warm neutrals hold their warmth in the dark: a grey inversion of a paper
  /// app reads as a different, colder product wearing the same layout.
  static const Ground dark = Ground(
    paper: Color(0xFF1A1C1E),
    surface: Color(0xFF212426),
    sunken: Color(0xFF171A1C),
    line: Color(0xFF2E3134),
    lineSoft: Color(0xFF26292B),
    ink: Color(0xFFDCD9D4),
    inkMid: Color(0xFFB5B0A9),
    inkMute: Color(0xFF948E86),
    inkFaint: Color(0xFF6F6A64),
    accent: Color(0xFFD98A72),
    onAccent: Color(0xFF241512),
  );
}

/// One radius per kind of thing, so a dialog and a card and a field are
/// recognisably the same family at three sizes rather than seven guesses.
class Radii {
  static const double tag = 8;
  static const double field = 12;
  static const double card = 14;
  static const double panel = 18;
  static const double pill = 999;
}

/// Titles are set in the face the library is read in. A reading app saying so
/// in its own type costs nothing, and Literata ships with the app.
const String titleFace = 'Literata';

ThemeData themeFor(Ground g, Brightness brightness) {
  final base = ThemeData(brightness: brightness, useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: g.paper,
    colorScheme:
        ColorScheme.fromSeed(
          seedColor: g.accent,
          brightness: brightness,
        ).copyWith(
          surface: g.surface,
          primary: g.accent,
          onPrimary: g.onAccent,
          outlineVariant: g.line,
        ),
    dividerColor: g.line,
    textTheme: base.textTheme.apply(bodyColor: g.ink, displayColor: g.ink),
    appBarTheme: AppBarTheme(
      backgroundColor: g.surface,
      foregroundColor: g.ink,
      elevation: 0,
      scrolledUnderElevation: 0,
      titleTextStyle: TextStyle(
        fontFamily: titleFace,
        fontSize: 19,
        fontWeight: FontWeight.w600,
        color: g.ink,
      ),
    ),
    cardTheme: CardThemeData(
      color: g.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Radii.card),
        side: BorderSide(color: g.lineSoft),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: g.surface,
      indicatorColor: g.sunken,
      elevation: 0,
    ),
  );
}

/// The ground this screen is standing on.
///
/// Every screen was asking the same question of Theme.of(context) and writing
/// the same ternary, which is three lines of the same decision in every file.
Ground groundOf(BuildContext context) =>
    Theme.of(context).brightness == Brightness.dark
    ? Ground.dark
    : Ground.light;
