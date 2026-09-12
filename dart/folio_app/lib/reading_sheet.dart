import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart';

import 'reader.dart';
import 'theme.dart';

/// The type, the paper, and the room around the words.
///
/// Shown over the chapter rather than on a screen of its own, and every change
/// lands behind it as it is made. Reading type is not a thing anybody can
/// choose from a description — "nineteen point, one point seven" means nothing
/// until you see a paragraph of it — so the paragraph stays visible and the
/// sheet sits on the bottom third of it.
class ReadingSheet extends StatefulWidget {
  const ReadingSheet({required this.prefs, required this.onChanged, super.key});

  final ReadingPrefs prefs;
  final void Function(ReadingPrefs) onChanged;

  @override
  State<ReadingSheet> createState() => _ReadingSheetState();
}

class _ReadingSheetState extends State<ReadingSheet> {
  late ReadingPrefs _prefs = widget.prefs;

  void _set(ReadingPrefs next) {
    setState(() => _prefs = next);
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    /* The sheet wears the paper being chosen. Picking Sepia and getting a
       white sheet of sliders over a cream chapter is the change not happening
       as far as the eye is concerned — and the swatch you just pressed is the
       one thing on screen you are trying to judge. */
    final system = MediaQuery.platformBrightnessOf(context);
    final ground = readingGround(_prefs.theme, system);
    final brightness = brightnessOf(_prefs.theme, system);

    return Theme(
      data: themeFor(ground, brightness),
      child: Container(
        color: ground.surface,
        child: SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _Label('Paper', ground: ground),
                const SizedBox(height: 8),
                _Papers(
                  chosen: _prefs.theme,
                  outer: ground,
                  onChosen: (theme) => _set(_prefs.copyWith(theme: theme)),
                ),
                const SizedBox(height: 20),

                _Label('Face', ground: ground),
                const SizedBox(height: 8),
                _Faces(
                  chosen: _prefs.face,
                  onChosen: (face) => _set(_prefs.copyWith(face: face)),
                ),
                const SizedBox(height: 16),

                _Dial(
                  label: 'Size',
                  // said in points, because that is the number on the slider and
                  // a reader comparing two settings wants the number back
                  value: _prefs.size,
                  min: 12,
                  max: 34,
                  divisions: 22,
                  reading: _prefs.size.round().toString(),
                  ground: ground,
                  onChanged: (v) => _set(_prefs.copyWith(size: v)),
                ),
                _Dial(
                  label: 'Line spacing',
                  value: _prefs.lineHeight,
                  min: 1.1,
                  max: 2.5,
                  divisions: 14,
                  reading: _prefs.lineHeight.toStringAsFixed(1),
                  ground: ground,
                  onChanged: (v) => _set(_prefs.copyWith(lineHeight: v)),
                ),
                _Dial(
                  label: 'Margins',
                  value: _prefs.margin,
                  min: 0,
                  max: 48,
                  divisions: 12,
                  reading: _prefs.margin.round().toString(),
                  ground: ground,
                  onChanged: (v) => _set(_prefs.copyWith(margin: v)),
                ),
                _Dial(
                  label: 'Weight',
                  value: _prefs.weight.toDouble(),
                  min: 300,
                  max: 700,
                  divisions: 4,
                  reading: switch (_prefs.weight) {
                    <= 300 => 'Light',
                    <= 400 => 'Regular',
                    <= 500 => 'Medium',
                    <= 600 => 'Semibold',
                    _ => 'Bold',
                  },
                  ground: ground,
                  onChanged: (v) => _set(_prefs.copyWith(weight: v.round())),
                ),

                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('Justify', style: TextStyle(color: ground.ink)),
                  subtitle: Text(
                    'Even right edge. On a narrow screen it opens gaps between '
                    'words, since a phone will not hyphenate to close them.',
                    style: TextStyle(fontSize: 12.5, color: ground.inkMute),
                  ),
                  value: _prefs.justified,
                  onChanged: (on) => _set(_prefs.copyWith(justified: on)),
                ),

                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: _prefs == const ReadingPrefs()
                        ? null
                        : () => _set(const ReadingPrefs()),
                    child: const Text('Back to the defaults'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text, {required this.ground});

  final String text;
  final Ground ground;

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerLeft,
    child: Text(
      text.toUpperCase(),
      style: TextStyle(
        fontSize: 11,
        letterSpacing: 0.9,
        fontWeight: FontWeight.w600,
        color: ground.inkFaint,
      ),
    ),
  );
}

/// The papers, shown as paper rather than named.
class _Papers extends StatelessWidget {
  const _Papers({
    required this.chosen,
    required this.outer,
    required this.onChosen,
  });

  final ReadingTheme chosen;
  final Ground outer;
  final void Function(ReadingTheme) onChosen;

  @override
  Widget build(BuildContext context) {
    final system = MediaQuery.platformBrightnessOf(context);
    return Row(
      children: [
        for (final theme in ReadingTheme.values)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 8),
              child: _Swatch(
                theme: theme,
                ground: readingGround(theme, system),
                outer: outer,
                chosen: theme == chosen,
                onTap: () => onChosen(theme),
              ),
            ),
          ),
      ],
    );
  }
}

class _Swatch extends StatelessWidget {
  const _Swatch({
    required this.theme,
    required this.ground,
    required this.outer,
    required this.chosen,
    required this.onTap,
  });

  final ReadingTheme theme;

  /// The paper this swatch is offering.
  final Ground ground;

  /// The paper it is sitting on, which is what its own outline has to be
  /// legible against — a black swatch chosen on black paper needs a border
  /// that can be seen.
  final Ground outer;

  final bool chosen;
  final VoidCallback onTap;

  static const Map<ReadingTheme, String> _names = {
    ReadingTheme.system: 'Auto',
    ReadingTheme.light: 'Day',
    ReadingTheme.sepia: 'Sepia',
    ReadingTheme.dark: 'Night',
    ReadingTheme.black: 'Black',
  };

  @override
  Widget build(BuildContext context) => Semantics(
    selected: chosen,
    button: true,
    label: _names[theme],
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Radii.field),
      child: Column(
        children: [
          Container(
            height: 46,
            decoration: BoxDecoration(
              color: ground.paper,
              borderRadius: BorderRadius.circular(Radii.field),
              border: Border.all(
                color: chosen ? outer.accent : outer.line,
                width: chosen ? 2 : 1,
              ),
            ),
            // the swatch is a paragraph, small: what is being chosen is how
            // ink sits on that paper, not the colour of the paper alone
            child: Center(
              child: Text(
                'Aa',
                style: TextStyle(
                  fontFamily: titleFace,
                  fontSize: 17,
                  color: ground.ink,
                ),
              ),
            ),
          ),
          const SizedBox(height: 5),
          Text(
            _names[theme]!,
            style: TextStyle(
              fontSize: 11,
              color: chosen ? outer.accent : outer.inkMute,
              fontWeight: chosen ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ],
      ),
    ),
  );
}

/// The faces, each set in itself, since a face named is a face not seen.
class _Faces extends StatelessWidget {
  const _Faces({required this.chosen, required this.onChosen});

  final ReadingFace chosen;
  final void Function(ReadingFace) onChosen;

  static const Map<ReadingFace, String> _names = {
    ReadingFace.literata: 'Literata',
    ReadingFace.atkinson: 'Hyperlegible',
    ReadingFace.serif: 'Serif',
    ReadingFace.system: 'System',
    ReadingFace.monospace: 'Mono',
  };

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 8,
    runSpacing: 8,
    children: [
      for (final face in _names.keys)
        ChoiceChip(
          selected: face == chosen,
          onSelected: (_) => onChosen(face),
          showCheckmark: false,
          label: Text(
            _names[face]!,
            style: TextStyle(fontFamily: familyFor(face), fontSize: 14),
          ),
        ),
    ],
  );
}

class _Dial extends StatelessWidget {
  const _Dial({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.divisions,
    required this.reading,
    required this.ground,
    required this.onChanged,
  });

  final String label;
  final double value;
  final double min;
  final double max;
  final int divisions;
  final String reading;
  final Ground ground;
  final void Function(double) onChanged;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      SizedBox(
        width: 96,
        child: Text(label, style: TextStyle(color: ground.inkMid)),
      ),
      Expanded(
        child: Slider(
          value: value.clamp(min, max),
          min: min,
          max: max,
          divisions: divisions,
          label: reading,
          onChanged: onChanged,
        ),
      ),
      SizedBox(
        width: 62,
        child: Text(
          reading,
          textAlign: TextAlign.end,
          style: TextStyle(fontSize: 12.5, color: ground.inkMute),
        ),
      ),
    ],
  );
}
