import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:folio_core/folio_core.dart'
    show ReadingFace, ReadingPrefs, dataUri;
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'theme.dart';

/// A chapter read the way its author wrote it.
///
/// Most works are laid out as native text. This is for the ones carrying a
/// work skin, where the CSS *is* the work: a chat fic, a newspaper clipping, a
/// letter in a different hand. There is no way to be faithful to that without
/// a cascade, so those chapters are rendered by the same engine the archive
/// renders them with.
/// Stored pictures, put where their addresses were.
///
/// In the chapter's markup and in the author's own stylesheet alike: a skin
/// names backgrounds and webfonts, and one whose assets are still on somebody
/// else's server is a chapter that phones out every time it is opened — or,
/// with the network shut off as it is here, one that renders wrongly for ever.
///
/// A data URI rather than a file or a local server: this page is built as a
/// string and handed to the engine, and a picture served from anywhere else
/// is a second thing to keep in step with the first.
String withPictures(
  String html,
  Map<String, ({String mime, Uint8List bytes})> held,
) {
  if (held.isEmpty) return html;
  var out = html;
  held.forEach((url, picture) {
    out = out.replaceAll(url, dataUri(picture.mime, picture.bytes));
  });
  return out;
}

class SkinnedChapterView extends StatefulWidget {
  const SkinnedChapterView({
    required this.chapterHtml,
    required this.skinCss,
    required this.settings,
    this.pictures = const {},
    required this.plainly,
    super.key,
  });

  final String chapterHtml;

  /// The pictures this work carries, by the address its markup points at.
  final Map<String, ({String mime, Uint8List bytes})> pictures;

  /// The same chapter as plain text, for when the skin will not render.
  final Widget Function(String? why) plainly;
  final String? skinCss;
  final ReadingChrome settings;

  @override
  State<SkinnedChapterView> createState() => _SkinnedChapterViewState();
}

/// The typography the reader chose, in the form CSS wants it.
class ReadingChrome {
  const ReadingChrome({
    this.size = 19,
    this.lineHeight = 1.7,
    this.family = 'Georgia, serif',
    this.weight = 400,
    this.margin = 20,
    this.justified = false,
    this.dark = false,
    this.ground = Ground.light,
  });

  /// The same choice the native reader is painting with, so a work with a skin
  /// and a work without one are read at the same size on the same paper. What
  /// a skin overrides it overrides on purpose; everything else is the reader's.
  factory ReadingChrome.from(
    ReadingPrefs prefs, {
    required Ground ground,
    required bool dark,
  }) => ReadingChrome(
    size: prefs.size,
    lineHeight: prefs.lineHeight,
    family: cssFamily(prefs.face),
    weight: prefs.weight,
    margin: prefs.margin,
    justified: prefs.justified,
    dark: dark,
    ground: ground,
  );

  final double size;
  final double lineHeight;
  final String family;
  final int weight;
  final double margin;
  final bool justified;
  final bool dark;
  final Ground ground;

  @override
  bool operator ==(Object other) =>
      other is ReadingChrome &&
      other.size == size &&
      other.lineHeight == lineHeight &&
      other.family == family &&
      other.weight == weight &&
      other.margin == margin &&
      other.justified == justified &&
      other.dark == dark &&
      other.ground == ground;

  @override
  int get hashCode => Object.hash(
    size,
    lineHeight,
    family,
    weight,
    margin,
    justified,
    dark,
    ground,
  );
}

/// The face, as a CSS stack.
///
/// Literata and Atkinson ship with the app as Flutter assets, which a WebView
/// cannot reach: it has its own resource loader and no view of the bundle. So
/// a skinned chapter asks for the family by name — a device that has it uses
/// it — and names a real fallback after it rather than landing on whatever the
/// engine defaults to. The native reader, which is most reading, has the
/// actual files.
String cssFamily(ReadingFace face) => switch (face) {
  ReadingFace.literata => "Literata, Georgia, 'Times New Roman', serif",
  ReadingFace.atkinson =>
    "'Atkinson Hyperlegible', 'Helvetica Neue', Arial, sans-serif",
  ReadingFace.serif => "Georgia, 'Times New Roman', serif",
  ReadingFace.monospace => "ui-monospace, 'Roboto Mono', monospace",
  ReadingFace.system => 'system-ui, sans-serif',
};

class _SkinnedChapterViewState extends State<SkinnedChapterView> {
  String? _document;
  String? _trouble;

  /// A chapter is worth reading without its skin.
  ///
  /// Falling back rather than showing a black rectangle: the skin is the
  /// work, but the words are more of it, and a reader staring at nothing has
  /// no way to know whether the chapter is empty or the engine gave up.
  bool _plainly = false;

  /// Did anything actually come out?
  ///
  /// A webview that renders nothing raises no error: it simply occupies the
  /// screen and shows a rectangle. That is the failure that cost a chapter
  /// its text and told nobody, so the height of the document is asked for
  /// once the load has stopped, and nothing is a failure like any other.
  Future<void> _didItPaint(InAppWebViewController controller) async {
    try {
      final tall = await controller.getContentHeight() ?? 0;
      if (tall > 0) return;
      _wentWrong('the chapter came out with no height');
    } catch (e) {
      _wentWrong('$e');
    }
  }

  void _wentWrong(String why) {
    if (!mounted || _plainly) return;
    setState(() {
      _plainly = true;
      _trouble = why;
    });
  }

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  @override
  void didUpdateWidget(SkinnedChapterView old) {
    super.didUpdateWidget(old);
    /* The typography is baked into the document, so a change to it is a new
       document. Without this the sheet moves every slider in the app and the
       skinned works are the ones that quietly ignore it. */
    if (old.settings != widget.settings ||
        old.chapterHtml != widget.chapterHtml ||
        old.skinCss != widget.skinCss) {
      _prepare();
    }
  }

  Future<void> _prepare() async {
    try {
      final archiveCss = await rootBundle.loadString('assets/ao3-work.css');
      final page = _page(archiveCss);
      if (!mounted) return;
      setState(() => _document = page);
    } catch (e) {
      if (!mounted) return;
      setState(() => _trouble = '$e');
    }
  }

  /// The page, assembled in the order a browser resolves it.
  ///
  /// The archive's own stylesheet first, then the reader's typography, then
  /// the author's skin last so it wins — which is the whole point of a skin.
  /// JavaScript is off: this is a stranger's markup rendered next to somebody's
  /// library, and nothing in a work has any business running.
  String _page(String archiveCss) {
    final s = widget.settings;
    final ground = s.ground;
    String hex(Color c) =>
        '#${(c.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

    return '''
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>$archiveCss</style>
<style>
  :root { color-scheme: ${s.dark ? 'dark' : 'light'}; }
  html, body {
    margin: 0;
    background: ${hex(ground.paper)};
    color: ${hex(ground.ink)};
    font-family: ${s.family};
    font-size: ${s.size}px;
    font-weight: ${s.weight};
    line-height: ${s.lineHeight};
    padding: ${s.margin}px;
    text-align: ${s.justified ? 'justify' : 'start'};
    overflow-x: clip;
  }
  #workskin img, img { max-width: 100%; height: auto; }
  a { color: ${hex(ground.accent)}; }
</style>
<article id="workskin">
<style>${withPictures(widget.skinCss ?? '', widget.pictures)}</style>
${withPictures(widget.chapterHtml, widget.pictures)}
</article>
''';
  }

  @override
  Widget build(BuildContext context) {
    if (_plainly) return widget.plainly(_trouble);
    if (_trouble != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_trouble!),
        ),
      );
    }
    final document = _document;
    if (document == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return InAppWebView(
      initialData: InAppWebViewInitialData(
        data: document,
        baseUrl: WebUri('https://archiveofourown.org/'),
        mimeType: 'text/html',
        encoding: 'utf-8',
      ),
      initialSettings: InAppWebViewSettings(
        /* Off. This is a stranger's markup rendered next to somebody's
           library, and nothing in a work has any business running. */
        javaScriptEnabled: false,
        /* And it reaches nothing. The chapter, the archive's stylesheet and
           the work's own skin are all handed over as text; anything else a
           skin names — a background, a webfont, a hotlinked picture — sits on
           somebody else's server, and fetching it says when and where this
           work was read to a host the reader never chose. An offline reader
           that quietly phones out is not one. */
        blockNetworkLoads: true,
        blockNetworkImage: true,
        /* Painted rather than transparent. A transparent webview that has
           failed to render looks exactly like the page behind it, which is
           how a broken chapter reads as an empty one. */
        transparentBackground: false,
        supportZoom: false,
        disableHorizontalScroll: true,
      ),
      onReceivedError: (_, __, error) => _wentWrong(error.description),
      onReceivedHttpError: (_, __, response) =>
          _wentWrong('the page answered ${response.statusCode}'),
      onLoadStop: (controller, _) => _didItPaint(controller),
    );
  }
}
