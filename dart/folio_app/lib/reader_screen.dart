import 'dart:async';

import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'chapter_web.dart';
import 'library.dart';
import 'reader.dart';
import 'theme.dart';

/// Reading a work: the chapter, the way to the next one, and the place kept.
class ReaderScreen extends StatefulWidget {
  const ReaderScreen({
    required this.library,
    required this.work,
    required this.chapters,
    this.startAt = 1,
    this.startOffset = 0,
    super.key,
  });

  final Library library;
  final WorkRow work;
  final List<ChapterRow> chapters;
  final int startAt;
  final double startOffset;

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  late int _chapter = widget.startAt;
  final ScrollController _scroll = ScrollController();
  Timer? _settling;
  double _openedAt = 0;
  bool _finishedThisVisit = false;
  Future<String?>? _html;

  int get _total => widget.chapters.isEmpty
      ? (widget.work.chapterCount ?? 1)
      : widget.chapters.length;

  @override
  void initState() {
    super.initState();
    _openedAt = widget.startOffset;
    _html = widget.library.chapterHtml(widget.work.workId, _chapter);
    _scroll.addListener(_moved);
    // Opening a work is what puts it on the Continue reading shelf, and
    // nothing else records it: a work opened and read without scrolling would
    // otherwise leave no trace at all.
    unawaited(widget.library.opened(widget.work.workId));
    WidgetsBinding.instance.addPostFrameCallback((_) => _restore());
  }

  @override
  void dispose() {
    _settling?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  void _restore() {
    if (!_scroll.hasClients || widget.startOffset <= 0) return;
    final limit = _scroll.position.maxScrollExtent;
    _scroll.jumpTo(widget.startOffset.clamp(0, limit));
  }

  /// Remembered after the scrolling stops, not during it: writing on every
  /// frame is a write per pixel.
  void _moved() {
    _settling?.cancel();
    _settling = Timer(const Duration(milliseconds: 400), _settle);
  }

  Future<void> _settle() async {
    if (!mounted || !_scroll.hasClients) return;
    final y = _scroll.offset;
    await widget.library.savePlace(widget.work.workId, _chapter, y);

    /* Reaching the end is a real event with a real write behind it. The rule
       is in folio_core, where it is tested against the numbers a phone
       reports — because the version of it that lived inside a reader was
       wrong in a way only a phone could show, and finished works nobody had
       read. */
    if (_finishedThisVisit || _chapter < _total) return;
    final reached = core.reachedTheEnd(
      scrollY: y,
      innerHeight: _scroll.position.viewportDimension,
      scrollHeight:
          _scroll.position.maxScrollExtent + _scroll.position.viewportDimension,
      openedAt: _openedAt,
    );
    if (!reached) return;
    _finishedThisVisit = true;
    await widget.library.finish(widget.work.workId);
  }

  Future<void> _go(int to) async {
    if (to < 1 || to > _total) return;
    await _settle();
    setState(() {
      _chapter = to;
      _openedAt = 0;
      _finishedThisVisit = false;
      _html = widget.library.chapterHtml(widget.work.workId, to);
    });
    if (_scroll.hasClients) _scroll.jumpTo(0);
    await widget.library.savePlace(widget.work.workId, to, 0);
  }

  void _pickChapter() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (context) => ListView.builder(
        itemCount: widget.chapters.length,
        itemBuilder: (context, i) {
          final ch = widget.chapters[i];
          return ListTile(
            selected: ch.number == _chapter,
            title: Text(
              ch.title?.isNotEmpty == true
                  ? '${ch.number}. ${ch.title}'
                  : 'Chapter ${ch.number}',
            ),
            onTap: () {
              Navigator.of(context).pop();
              _go(ch.number);
            },
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final ground = dark ? Ground.dark : Ground.light;

    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.work.title,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: FutureBuilder<String?>(
        future: _html,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          final html = snapshot.data;
          if (html == null) {
            return const Center(child: Text('That chapter is not here.'));
          }
          /* The skin is the work: a chat fic, a letter in another hand. There
             is no being faithful to that without a cascade, so those chapters
             go to the engine the archive renders them with. */
          if (core.needsWebView(skinCss: widget.work.skinCss)) {
            return SkinnedChapterView(
              chapterHtml: html,
              skinCss: widget.work.skinCss,
              settings: ReadingChrome(dark: dark),
            );
          }
          return ChapterView(
            document: core.parseChapter(html),
            settings: const ReadingSettings(),
            controller: _scroll,
          );
        },
      ),
      bottomNavigationBar: _total <= 1
          ? null
          : BottomAppBar(
              color: ground.surface,
              height: 58,
              padding: EdgeInsets.zero,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  IconButton(
                    onPressed: _chapter > 1 ? () => _go(_chapter - 1) : null,
                    icon: const Icon(Icons.chevron_left),
                    tooltip: 'Previous chapter',
                  ),
                  TextButton(
                    onPressed: widget.chapters.isEmpty ? null : _pickChapter,
                    child: Text('$_chapter / $_total'),
                  ),
                  IconButton(
                    onPressed: _chapter < _total
                        ? () => _go(_chapter + 1)
                        : null,
                    icon: const Icon(Icons.chevron_right),
                    tooltip: 'Next chapter',
                  ),
                ],
              ),
            ),
    );
  }
}
