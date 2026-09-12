import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
// Align, Picture and Paragraph all have namesakes in Flutter. Prefixed
// rather than renamed: the model's names are the right ones for a
// document, and a prefix says which vocabulary is being spoken.
import 'package:folio_core/folio_core.dart' as core;

import 'theme.dart';

/// A chapter laid out as native text.
///
/// The model comes from folio_core, where it is tested against the words of
/// real chapters. This only paints it: what a mark looks like, how far a
/// paragraph is from the next one, where the measure ends.
class ChapterView extends StatelessWidget {
  const ChapterView({
    required this.document,
    required this.settings,
    this.onLinkTapped,
    super.key,
  });

  final core.ChapterDocument document;
  final ReadingSettings settings;
  final void Function(String href)? onLinkTapped;

  @override
  Widget build(BuildContext context) {
    final ground = Theme.of(context).brightness == Brightness.dark
        ? Ground.dark
        : Ground.light;
    return ListView.builder(
      padding: EdgeInsets.symmetric(
        horizontal: settings.margin,
        vertical: settings.verticalMargin,
      ),
      itemCount: document.blocks.length,
      itemBuilder: (context, i) => _BlockView(
        block: document.blocks[i],
        settings: settings,
        ground: ground,
        onLinkTapped: onLinkTapped,
      ),
    );
  }
}

/// What the reader has chosen. The same settings 1.x stores, so a reader who
/// found their setup keeps it across the versions.
class ReadingSettings {
  const ReadingSettings({
    this.size = 19,
    this.lineHeight = 1.7,
    this.family = 'Literata',
    this.weight = FontWeight.w400,
    this.margin = 20,
    this.verticalMargin = 24,
    this.align = TextAlign.start,
  });

  final double size;
  final double lineHeight;
  final String family;
  final FontWeight weight;
  final double margin;
  final double verticalMargin;
  final TextAlign align;

  TextStyle get body => TextStyle(
        fontFamily: family,
        fontSize: size,
        height: lineHeight,
        fontWeight: weight,
      );
}

class _BlockView extends StatelessWidget {
  const _BlockView({
    required this.block,
    required this.settings,
    required this.ground,
    this.onLinkTapped,
  });

  final core.Block block;
  final ReadingSettings settings;
  final Ground ground;
  final void Function(String href)? onLinkTapped;

  @override
  Widget build(BuildContext context) {
    /* A switch statement over a sealed type: Dart checks it covers every
       block, so a shape added to the model cannot be quietly left unpainted
       here — the analyzer says so before a chapter goes missing a table. */
    switch (block) {
      case core.Paragraph(:final runs, :final align):
        return Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: Text.rich(
            _span(runs),
            textAlign: _align(align) ?? settings.align,
          ),
        );

      case core.Heading(:final level, :final runs, :final align):
        return Padding(
          padding: const EdgeInsets.only(top: 18, bottom: 10),
          child: Text.rich(
            _span(
              runs,
              style: settings.body.copyWith(
                fontFamily: titleFace,
                fontSize: settings.size * (level <= 2 ? 1.35 : 1.15),
                fontWeight: FontWeight.w600,
                height: 1.25,
              ),
            ),
            textAlign: _align(align) ?? settings.align,
          ),
        );

      case core.Quote(:final children):
        return Container(
          margin: const EdgeInsets.only(bottom: 14),
          padding: const EdgeInsets.only(left: 14),
          decoration: BoxDecoration(
            border: Border(left: BorderSide(color: ground.line, width: 3)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final child in children)
                _BlockView(
                  block: child,
                  settings: settings,
                  ground: ground,
                  onLinkTapped: onLinkTapped,
                ),
            ],
          ),
        );

      case core.BulletList(:final items, :final ordered):
        return Padding(
          padding: const EdgeInsets.only(bottom: 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < items.length; i++)
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 28,
                      child: Text(
                        ordered ? '${i + 1}.' : '\u2022',
                        style: settings.body.copyWith(color: ground.inkMute),
                      ),
                    ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          for (final child in items[i])
                            _BlockView(
                              block: child,
                              settings: settings,
                              ground: ground,
                              onLinkTapped: onLinkTapped,
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
            ],
          ),
        );

      // A scene break. Fic leans on these and losing them loses the pacing.
      case core.Rule():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 22),
          child: Center(
            child: SizedBox(
              width: 72,
              child: Divider(color: ground.line, thickness: 1),
            ),
          ),
        );

      case core.Picture(:final src, :final alt):
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Semantics(
            label: alt,
            child: Image.network(
              src,
              errorBuilder: (context, error, stack) => Text(
                alt ?? 'a picture that is not here',
                style: settings.body.copyWith(
                  color: ground.inkFaint,
                  fontStyle: FontStyle.italic,
                ),
              ),
            ),
          ),
        );

      case core.Preformatted(:final text):
        return Container(
          margin: const EdgeInsets.only(bottom: 14),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: ground.sunken,
            borderRadius: BorderRadius.circular(Radii.tag),
          ),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Text(
              text,
              style: settings.body.copyWith(fontFamily: 'monospace'),
            ),
          ),
        );

      /* Something the native reader has no shape for — a table, most often.
         Saying so is better than flattening it into a column of fragments,
         and better than dropping it, which is a scene the reader never learns
         was there. */
      case core.Unsupported(:final tag):
        return Container(
          margin: const EdgeInsets.only(bottom: 14),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: ground.sunken,
            borderRadius: BorderRadius.circular(Radii.tag),
          ),
          child: Text(
            'A $tag here reads better in the archive\u2019s own layout.',
            style: settings.body.copyWith(fontSize: 14, color: ground.inkMute),
          ),
        );
    }
  }

  TextAlign? _align(core.BlockAlign align) => switch (align) {
        core.BlockAlign.start => null,
        core.BlockAlign.center => TextAlign.center,
        core.BlockAlign.end => TextAlign.end,
        core.BlockAlign.justify => TextAlign.justify,
      };

  TextSpan _span(List<core.Run> runs, {TextStyle? style}) {
    final base = style ?? settings.body;
    return TextSpan(
      children: [
        for (final run in runs)
          TextSpan(
            text: run.text,
            style: _styleFor(run, base),
            recognizer: run.href == null || onLinkTapped == null
                ? null
                : (TapGestureRecognizer()..onTap = () => onLinkTapped!(run.href!)),
          ),
      ],
    );
  }

  TextStyle _styleFor(core.Run run, TextStyle base) {
    var style = base;
    for (final mark in run.marks) {
      style = switch (mark) {
        core.Mark.emphasis => style.copyWith(fontStyle: FontStyle.italic),
        core.Mark.strong => style.copyWith(fontWeight: FontWeight.w700),
        core.Mark.underline => style.copyWith(decoration: TextDecoration.underline),
        core.Mark.strike => style.copyWith(decoration: TextDecoration.lineThrough),
        core.Mark.code => style.copyWith(fontFamily: 'monospace'),
        core.Mark.small => style.copyWith(fontSize: style.fontSize! * 0.85),
        // Dart has no baseline shift in a TextStyle, so these are said by size
        core.Mark.superscript ||
        core.Mark.subscript =>
          style.copyWith(fontSize: style.fontSize! * 0.75),
      };
    }
    if (run.href != null) {
      style = style.copyWith(
        color: ground.accent,
        decoration: TextDecoration.underline,
        decorationColor: ground.accent.withValues(alpha: 0.4),
      );
    }
    return style;
  }
}
