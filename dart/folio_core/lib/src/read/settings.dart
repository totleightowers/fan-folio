/// How the reader wants to be read to.
///
/// Kept in the library's own meta table rather than in the app's preferences,
/// so it travels in a backup with everything else. Somebody who has found
/// their setup should not lose it by moving phones, and a reading position
/// restored without the type it was read in is only half the place.
library;

import '../store/migrate.dart' show SqlRunner;

/// The named grounds. Sepia is not a tint of light — it is its own paper.
enum ReadingTheme { system, light, sepia, dark, black }

/// A face the app can promise. Anything else is a name it cannot keep.
enum ReadingFace { literata, system, serif, monospace, atkinson }

class ReadingPrefs {
  const ReadingPrefs({
    this.size = 19,
    this.lineHeight = 1.7,
    this.face = ReadingFace.literata,
    this.weight = 400,
    this.margin = 20,
    this.verticalMargin = 24,
    this.justified = false,
    this.theme = ReadingTheme.system,
  });

  factory ReadingPrefs.fromMap(Map<String, String> stored) {
    T pick<T extends Enum>(String key, List<T> values, T fallback) {
      final name = stored[key];
      for (final value in values) {
        if (value.name == name) return value;
      }
      return fallback;
    }

    double number(String key, double fallback, double low, double high) {
      final value = double.tryParse(stored[key] ?? '');
      return value == null ? fallback : value.clamp(low, high);
    }

    return ReadingPrefs(
      // clamped, because a stored setting is a number somebody's finger chose
      // on a slider and a number a future version may not have meant
      size: number('read.size', 19, 12, 34),
      lineHeight: number('read.lineHeight', 1.7, 1.1, 2.5),
      face: pick('read.face', ReadingFace.values, ReadingFace.literata),
      weight: number('read.weight', 400, 300, 700).round(),
      margin: number('read.margin', 20, 0, 48),
      verticalMargin: number('read.vmargin', 24, 0, 64),
      justified: stored['read.justified'] == 'true',
      theme: pick('read.theme', ReadingTheme.values, ReadingTheme.system),
    );
  }

  final double size;
  final double lineHeight;
  final ReadingFace face;
  final int weight;
  final double margin;
  final double verticalMargin;
  final bool justified;
  final ReadingTheme theme;

  Map<String, String> toMap() => {
        'read.size': '$size',
        'read.lineHeight': '$lineHeight',
        'read.face': face.name,
        'read.weight': '$weight',
        'read.margin': '$margin',
        'read.vmargin': '$verticalMargin',
        'read.justified': '$justified',
        'read.theme': theme.name,
      };

  ReadingPrefs copyWith({
    double? size,
    double? lineHeight,
    ReadingFace? face,
    int? weight,
    double? margin,
    double? verticalMargin,
    bool? justified,
    ReadingTheme? theme,
  }) =>
      ReadingPrefs(
        size: size ?? this.size,
        lineHeight: lineHeight ?? this.lineHeight,
        face: face ?? this.face,
        weight: weight ?? this.weight,
        margin: margin ?? this.margin,
        verticalMargin: verticalMargin ?? this.verticalMargin,
        justified: justified ?? this.justified,
        theme: theme ?? this.theme,
      );

  /// Two setups are the same setup if they read the same. Worth having so the
  /// reader can tell whether anything has changed since it last wrote, and so
  /// "back to the defaults" can be offered only when it would do something.
  @override
  bool operator ==(Object other) =>
      other is ReadingPrefs &&
      other.size == size &&
      other.lineHeight == lineHeight &&
      other.face == face &&
      other.weight == weight &&
      other.margin == margin &&
      other.verticalMargin == verticalMargin &&
      other.justified == justified &&
      other.theme == theme;

  @override
  int get hashCode => Object.hash(
        size,
        lineHeight,
        face,
        weight,
        margin,
        verticalMargin,
        justified,
        theme,
      );
}

/// Read them back out of the library.
Future<ReadingPrefs> loadPrefs(SqlRunner db) async {
  try {
    final rows = await db.query(
      "SELECT key, value FROM meta WHERE key LIKE 'read.%'",
    );
    return ReadingPrefs.fromMap({
      for (final row in rows) '${row['key']}': '${row['value']}',
    });
  } catch (_) {
    // a library from before this existed has no such rows, and a reader with
    // no saved setup gets the default one rather than an error
    return const ReadingPrefs();
  }
}
