import 'dart:typed_data';

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
    this.controller,
    this.onLinkTapped,
    this.pictures = const {},
    this.onFetchPicture,
    super.key,
  });

  final core.ChapterDocument document;
  final ReadingSettings settings;

  /// Held by whoever is keeping the reader's place, since the place outlives
  /// the chapter being looked at.
  final ScrollController? controller;
  final void Function(String href)? onLinkTapped;

  /// The pictures this work carries, by the address its markup points at.
  ///
  /// A chapter that reaches the network for its images is a chapter that
  /// shows grey boxes in a tunnel, which is the one thing an offline reader
  /// is for — and it is a chapter that tells a stranger's server when and
  /// where somebody read it.
  final Map<String, ({String mime, Uint8List bytes})> pictures;

  /// Fetch one picture and keep it. Null while there is nobody to ask.
  final Future<Uint8List?> Function(String src)? onFetchPicture;

  @override
  Widget build(BuildContext context) {
    final ground = Theme.of(context).brightness == Brightness.dark
        ? Ground.dark
        : Ground.light;
    return ListView.builder(
      controller: controller,
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
        pictures: pictures,
        onFetchPicture: onFetchPicture,
      ),
    );
  }
}

/// What the reader has chosen, ready to paint with.
///
/// The choice itself lives in folio_core and is kept in the library, so it
/// travels in a backup with everything else. This is that choice turned into
/// the things Flutter needs: a family name, a weight, an alignment.
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

  factory ReadingSettings.from(core.ReadingPrefs prefs) => ReadingSettings(
    size: prefs.size,
    lineHeight: prefs.lineHeight,
    family: familyFor(prefs.face),
    weight: weightFor(prefs.weight),
    margin: prefs.margin,
    verticalMargin: prefs.verticalMargin,
    /* Justification is a preference and not a default, because justified text
       without hyphenation — which is what a phone gives you — opens rivers of
       white down a narrow measure. Somebody who wants it knows they want it. */
    align: prefs.justified ? TextAlign.justify : TextAlign.start,
  );

  final double size;
  final double lineHeight;

  /// Null means whatever the device reads in, which is the right answer for
  /// anyone who has already set that up for themselves system-wide.
  final String? family;
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

/// A face the app can actually promise.
///
/// Two of these ship with the app, so they are there with no connection and
/// cannot quietly turn into something else on the way; the other two are names
/// Android resolves itself. Nothing here is a family that might not exist.
String? familyFor(core.ReadingFace face) => switch (face) {
  core.ReadingFace.literata => 'Literata',
  // Atkinson Hyperlegible was drawn by the Braille Institute to be legible to
  // low vision readers: the letters that usually collapse into each other —
  // I l 1, O 0, b d — are drawn to be told apart. For some people it is the
  // difference between reading a chapter and giving up on it.
  core.ReadingFace.atkinson => 'Atkinson Hyperlegible',
  core.ReadingFace.serif => 'serif',
  core.ReadingFace.monospace => 'monospace',
  core.ReadingFace.system => null,
};

/// The slider gives a number; Flutter wants one of nine.
FontWeight weightFor(int weight) =>
    FontWeight.values[((weight ~/ 100) - 1).clamp(0, 8)];

class _BlockView extends StatelessWidget {
  const _BlockView({
    required this.block,
    required this.settings,
    required this.ground,
    this.onLinkTapped,
    this.pictures = const {},
    this.onFetchPicture,
  });

  final core.Block block;
  final ReadingSettings settings;
  final Ground ground;
  final void Function(String href)? onLinkTapped;
  final Map<String, ({String mime, Uint8List bytes})> pictures;
  final Future<Uint8List?> Function(String src)? onFetchPicture;

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
                  pictures: pictures,
                  onFetchPicture: onFetchPicture,
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
                              pictures: pictures,
                              onFetchPicture: onFetchPicture,
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
        /* Held, or asked for. A picture kept with the work survives a tunnel
           and tells nobody it was looked at. One that was never fetched sits
           on somebody else's server, and reaching for it says when and where
           this work was read — to a host the reader never chose and this app
           has no relationship with. So it is offered rather than loaded. */
        final held = pictures[src];
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Semantics(
            label: alt,
            child: held != null
                ? Image.memory(
                    held.bytes,
                    errorBuilder: (context, error, stack) =>
                        _Absent(alt: alt, settings: settings, ground: ground),
                  )
                : _Elsewhere(
                    src: src,
                    alt: alt,
                    settings: settings,
                    ground: ground,
                    onFetch: onFetchPicture,
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
                : (TapGestureRecognizer()
                    ..onTap = () => onLinkTapped!(run.href!)),
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
        core.Mark.underline => style.copyWith(
          decoration: TextDecoration.underline,
        ),
        core.Mark.strike => style.copyWith(
          decoration: TextDecoration.lineThrough,
        ),
        core.Mark.code => style.copyWith(fontFamily: 'monospace'),
        core.Mark.small => style.copyWith(fontSize: style.fontSize! * 0.85),
        // Dart has no baseline shift in a TextStyle, so these are said by size
        core.Mark.superscript ||
        core.Mark.subscript => style.copyWith(fontSize: style.fontSize! * 0.75),
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

/// A picture the library does not hold.
///
/// Offered rather than fetched. One that was never downloaded sits on
/// somebody else's server, and reaching for it says when and where this work
/// was read — to a host the reader never chose and this app has no
/// relationship with. So it is a tap.
///
/// And what the tap fetches is kept. A picture asked for once is theirs: next
/// time, offline, and in a backup.
class _Elsewhere extends StatefulWidget {
  const _Elsewhere({
    required this.src,
    required this.alt,
    required this.settings,
    required this.ground,
    required this.onFetch,
  });

  final String src;
  final String? alt;
  final ReadingSettings settings;
  final Ground ground;
  final Future<Uint8List?> Function(String src)? onFetch;

  @override
  State<_Elsewhere> createState() => _ElsewhereState();
}

class _ElsewhereState extends State<_Elsewhere> {
  bool _asking = false;
  Uint8List? _got;
  bool _failed = false;

  Future<void> _ask() async {
    final fetch = widget.onFetch;
    if (fetch == null || _asking) return;
    setState(() => _asking = true);
    final bytes = await fetch(widget.src);
    if (!mounted) return;
    setState(() {
      _asking = false;
      _got = bytes;
      _failed = bytes == null;
    });
  }

  @override
  Widget build(BuildContext context) {
    final got = _got;
    if (got != null) {
      return Image.memory(
        got,
        errorBuilder: (context, error, stack) => _Absent(
          alt: widget.alt,
          settings: widget.settings,
          ground: widget.ground,
        ),
      );
    }

    return InkWell(
      onTap: widget.onFetch == null || _failed ? null : _ask,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: widget.ground.sunken,
          borderRadius: BorderRadius.circular(Radii.tag),
          border: Border.all(color: widget.ground.lineSoft),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_asking)
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              Icon(
                _failed ? Icons.broken_image_outlined : Icons.image_outlined,
                size: 18,
                color: widget.ground.inkMute,
              ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    widget.alt?.isNotEmpty ?? false
                        ? widget.alt!
                        : 'A picture, not downloaded',
                    style: widget.settings.body.copyWith(
                      fontSize: 13.5,
                      height: 1.4,
                      color: widget.ground.inkMid,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    _said(),
                    style: TextStyle(
                      fontSize: 12,
                      color: widget.ground.inkFaint,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _said() {
    if (_asking) return 'Fetching it from ${_host(widget.src)}…';
    if (_failed) return '${_host(widget.src)} would not give it up';
    if (widget.onFetch == null) return 'From ${_host(widget.src)}';
    return 'Tap to fetch it from ${_host(widget.src)} and keep it';
  }
}

/// Named, because who is being asked matters as much as whether to ask.
String _host(String src) => Uri.tryParse(src)?.host ?? 'elsewhere';

/// A picture that will not come, said in words rather than as a broken box.
class _Absent extends StatelessWidget {
  const _Absent({
    required this.alt,
    required this.settings,
    required this.ground,
  });

  final String? alt;
  final ReadingSettings settings;
  final Ground ground;

  @override
  Widget build(BuildContext context) => Text(
    alt ?? 'a picture that is not here',
    style: settings.body.copyWith(
      color: ground.inkFaint,
      fontStyle: FontStyle.italic,
    ),
  );
}
