import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' show ReadingTheme;

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
    line: Color(0xFF8A8071),
    lineSoft: Color(0xFFEFEAE1),
    ink: Color(0xFF1B1A17),
    inkMid: Color(0xFF4A453F),
    inkMute: Color(0xFF59554F),
    inkFaint: Color(0xFF6D665D),
    accent: Color(0xFF8C3B2E),
    onAccent: Color(0xFFFFFFFF),
  );

  /// Warm neutrals hold their warmth in the dark: a grey inversion of a paper
  /// app reads as a different, colder product wearing the same layout.
  static const Ground dark = Ground(
    paper: Color(0xFF151E1B),
    surface: Color(0xFF1E2925),
    sunken: Color(0xFF101915),
    line: Color(0xFF74877B),
    lineSoft: Color(0xFF2B3B33),
    ink: Color(0xFFEFF2ED),
    inkMid: Color(0xFFD1D9D3),
    inkMute: Color(0xFFB8C5BC),
    inkFaint: Color(0xFFAAB8AE),
    accent: Color(0xFFB6CFB4),
    onAccent: Color(0xFF152018),
  );

  /// Paper, for people who read on it. Not a filter over the light theme —
  /// the inks are warmed to match, because dark ink on cream at light-theme
  /// contrast is the one thing sepia is supposed to fix.
  static const Ground sepia = Ground(
    paper: Color(0xFFF4E9D6),
    surface: Color(0xFFFAF2E4),
    sunken: Color(0xFFEADCC2),
    line: Color(0xFF8B785C),
    lineSoft: Color(0xFFE5D6BB),
    ink: Color(0xFF3A3026),
    inkMid: Color(0xFF584A3B),
    inkMute: Color(0xFF675641),
    inkFaint: Color(0xFF6D5C47),
    accent: Color(0xFF8C3B2E),
    onAccent: Color(0xFFFAF2E4),
  );

  /// True black, which on an OLED screen is a pixel that is off: the reason to
  /// have it is a dark room and a battery, not a darker grey.
  static const Ground black = Ground(
    paper: Color(0xFF000000),
    surface: Color(0xFF101113),
    // a well is cut into the card, not into the page: below true black there
    // is nowhere to go, so the sunken ground sits between the two
    sunken: Color(0xFF08090A),
    line: Color(0xFF65756B),
    lineSoft: Color(0xFF16181A),
    ink: Color(0xFFEEF0EB),
    inkMid: Color(0xFFD1D6D0),
    inkMute: Color(0xFFBCC2BC),
    inkFaint: Color(0xFFA4AAA5),
    accent: Color(0xFFB6CFB4),
    onAccent: Color(0xFF152018),
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
          onSurface: g.ink,
          onSurfaceVariant: g.inkMid,
          outline: g.line,
          primary: g.accent,
          onPrimary: g.onAccent,
          outlineVariant: g.line,
        ),
    dividerColor: g.lineSoft,
    focusColor: g.accent.withValues(alpha: 0.24),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: g.accent,
      foregroundColor: g.onAccent,
    ),
    inputDecorationTheme: InputDecorationTheme(
      labelStyle: TextStyle(color: g.inkMid),
      hintStyle: TextStyle(color: g.inkMute),
      enabledBorder: OutlineInputBorder(borderSide: BorderSide(color: g.line)),
      focusedBorder: OutlineInputBorder(
        borderSide: BorderSide(color: g.accent, width: 2),
      ),
    ),
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

/// The ground a chapter is read on, which is not always the ground the rest of
/// the app is standing on.
///
/// Somebody reading in bed wants the reader dark and the library as it was;
/// somebody reading outdoors wants the opposite. So this is its own setting,
/// and `system` is the answer for the people for whom it is not a question.
Ground readingGround(ReadingTheme theme, Brightness system) => switch (theme) {
  ReadingTheme.system => system == Brightness.dark ? Ground.dark : Ground.light,
  ReadingTheme.light => Ground.light,
  ReadingTheme.sepia => Ground.sepia,
  ReadingTheme.dark => Ground.dark,
  ReadingTheme.black => Ground.black,
};

/// Light or dark for Material's own purposes. Sepia is a light theme with warm
/// paper; black is a dark one — getting this backwards gives a reader white
/// dialogs on black paper.
Brightness brightnessOf(ReadingTheme theme, Brightness system) =>
    switch (theme) {
      ReadingTheme.system => system,
      ReadingTheme.light || ReadingTheme.sepia => Brightness.light,
      ReadingTheme.dark || ReadingTheme.black => Brightness.dark,
    };
