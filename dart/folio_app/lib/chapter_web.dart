import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:webview_flutter/webview_flutter.dart';

import 'theme.dart';

/// A chapter read the way its author wrote it.
///
/// Most works are laid out as native text. This is for the ones carrying a
/// work skin, where the CSS *is* the work: a chat fic, a newspaper clipping, a
/// letter in a different hand. There is no way to be faithful to that without
/// a cascade, so those chapters are rendered by the same engine the archive
/// renders them with.
class SkinnedChapterView extends StatefulWidget {
  const SkinnedChapterView({
    required this.chapterHtml,
    required this.skinCss,
    required this.settings,
    super.key,
  });

  final String chapterHtml;
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
    this.family = 'Literata, Georgia, serif',
    this.margin = 20,
    this.dark = false,
  });

  final double size;
  final double lineHeight;
  final String family;
  final double margin;
  final bool dark;
}

class _SkinnedChapterViewState extends State<SkinnedChapterView> {
  WebViewController? _controller;
  String? _trouble;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  Future<void> _prepare() async {
    try {
      final archiveCss = await rootBundle.loadString('assets/ao3-work.css');
      final controller = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.disabled)
        ..setBackgroundColor(
          widget.settings.dark ? Ground.dark.paper : Ground.light.paper,
        )
        ..loadHtmlString(_document(archiveCss));
      if (!mounted) return;
      setState(() => _controller = controller);
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
  String _document(String archiveCss) {
    final s = widget.settings;
    final ground = s.dark ? Ground.dark : Ground.light;
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
    line-height: ${s.lineHeight};
    padding: ${s.margin}px;
    overflow-x: clip;
  }
  #workskin img, img { max-width: 100%; height: auto; }
  a { color: ${hex(ground.accent)}; }
</style>
<article id="workskin">
<style>${widget.skinCss ?? ''}</style>
${widget.chapterHtml}
</article>
''';
  }

  @override
  Widget build(BuildContext context) {
    if (_trouble != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(_trouble!),
        ),
      );
    }
    if (_controller == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return WebViewWidget(controller: _controller!);
  }
}
