import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'archive_acts.dart';
import 'chapter_web.dart';
import 'downloads.dart';
import 'library.dart';
import 'reader.dart';
import 'reading_sheet.dart';
import 'theme.dart';

/// Reading a work: the chapter, the way to the next one, and the place kept.
///
/// Chapters are pages rather than a list with two arrows under it. Turning a
/// page is the oldest gesture there is for this, and a reader who has to find
/// a small chevron at the foot of forty screens of text is being asked to do
/// something no book ever asked of them.
class ReaderScreen extends StatefulWidget {
  const ReaderScreen({
    required this.library,
    required this.work,
    required this.chapters,
    this.downloads,
    this.onShowWork,
    this.startAt = 1,
    this.startOffset = 0,
    super.key,
  });

  final Library library;
  final Downloads? downloads;
  final WorkRow work;
  final List<ChapterRow> chapters;

  /// The work's own page. Offered from the title, for the times the reader
  /// arrived here straight from Continue reading and never saw it.
  final VoidCallback? onShowWork;

  final int startAt;
  final double startOffset;

  @override
  State<ReaderScreen> createState() => _ReaderScreenState();
}

class _ReaderScreenState extends State<ReaderScreen> {
  late final PageController _pages = PageController(
    initialPage: widget.startAt - 1,
  );
  late int _chapter = widget.startAt;

  Timer? _settling;
  Timer? _prefsSettling;
  double _openedAt = 0;
  final Set<int> _finished = {};
  core.ReadingPrefs _prefs = const core.ReadingPrefs();
  bool _unsaved = false;

  /// Read once for the whole work. A reader turning to chapter nine should
  /// not wait on a query for a picture the app has held since chapter one.
  Map<String, ({String mime, Uint8List bytes})> _pictures = const {};

  /// How far through the chapter on screen is, for the line at the foot.
  double _through = 0;

  int get _total => widget.chapters.isEmpty
      ? (widget.work.chapterCount ?? 1)
      : widget.chapters.length;

  @override
  void initState() {
    super.initState();
    _openedAt = widget.startOffset;
    // Opening a work is what puts it on the Continue reading shelf, and
    // nothing else records it: a work opened and read without scrolling would
    // otherwise leave no trace at all.
    unawaited(widget.library.opened(widget.work.workId));
    unawaited(_loadPrefs());
    unawaited(_loadPictures());
  }

  @override
  void dispose() {
    _settling?.cancel();
    _prefsSettling?.cancel();
    // a setting changed and then left behind by closing the reader is still a
    // setting changed, so the pending write happens now rather than never
    _savePrefs();
    _pages.dispose();
    super.dispose();
  }

  Future<void> _loadPictures() async {
    final held = await widget.library.picturesFor(widget.work.workId);
    if (!mounted || held.isEmpty) return;
    setState(() => _pictures = held);
  }

  Future<void> _loadPrefs() async {
    final prefs = await widget.library.readingPrefs();
    if (!mounted) return;
    setState(() => _prefs = prefs);
  }

  /// Changed on screen at once, written a moment later: a slider dragged from
  /// fourteen point to twenty-two is thirty settings, and the reader should
  /// see all thirty and the library should be told once.
  void _changePrefs(core.ReadingPrefs prefs) {
    setState(() {
      _prefs = prefs;
      _unsaved = true;
    });
    _prefsSettling?.cancel();
    _prefsSettling = Timer(const Duration(milliseconds: 500), _savePrefs);
  }

  void _savePrefs() {
    if (!_unsaved) return;
    _unsaved = false;
    unawaited(widget.library.saveReadingPrefs(_prefs));
  }

  void _openSettings() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      // over the chapter, not instead of it: type is chosen by looking at it
      isScrollControlled: true,
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.62,
      ),
      builder: (context) =>
          ReadingSheet(prefs: _prefs, onChanged: _changePrefs),
    );
  }

  /// A page turned. The place moves with it, from the top.
  void _arrived(int page) {
    setState(() {
      _chapter = page + 1;
      _openedAt = 0;
      _through = 0;
    });
    unawaited(widget.library.savePlace(widget.work.workId, _chapter, 0));
  }

  void _turn(int to) {
    if (to < 1 || to > _total) return;
    _pages.animateToPage(
      to - 1,
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
    );
  }

  /// Where the reader has got to in the chapter on screen.
  ///
  /// Remembered after the scrolling stops, not during it: writing on every
  /// frame is a write per pixel.
  void _scrolled(int chapter, ScrollMetrics at) {
    if (chapter != _chapter) return;
    final span = at.maxScrollExtent;
    setState(() => _through = span <= 0 ? 1 : (at.pixels / span).clamp(0, 1));

    _settling?.cancel();
    _settling = Timer(
      const Duration(milliseconds: 400),
      () => _settle(chapter, at),
    );
  }

  Future<void> _settle(int chapter, ScrollMetrics at) async {
    if (!mounted) return;
    await widget.library.savePlace(widget.work.workId, chapter, at.pixels);

    /* Reaching the end is a real event with a real write behind it. The rule
       is in folio_core, where it is tested against the numbers a phone
       reports — because the version of it that lived inside a reader was
       wrong in a way only a phone could show, and finished works nobody had
       read. */
    if (_finished.contains(chapter) || chapter < _total) return;
    final reached = core.reachedTheEnd(
      scrollY: at.pixels,
      innerHeight: at.viewportDimension,
      scrollHeight: at.maxScrollExtent + at.viewportDimension,
      openedAt: _openedAt,
    );
    if (!reached) return;
    _finished.add(chapter);
    await widget.library.finish(widget.work.workId);
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
              _turn(ch.number);
            },
          );
        },
      ),
    );
  }

  String get _chapterName {
    for (final ch in widget.chapters) {
      if (ch.number == _chapter && (ch.title?.isNotEmpty ?? false)) {
        return ch.title!;
      }
    }
    return _total > 1 ? 'Chapter $_chapter' : widget.work.title;
  }

  @override
  Widget build(BuildContext context) {
    /* The reader carries its own light. Somebody reading in bed wants the
       chapter dark and the library as it was, so this is the reading theme
       rather than the app's, and it is put on with a Theme so the sheet and
       its sliders come up on the same paper as the words behind them. */
    final system = MediaQuery.platformBrightnessOf(context);
    final brightness = brightnessOf(_prefs.theme, system);
    final ground = readingGround(_prefs.theme, system);
    final dark = brightness == Brightness.dark;

    return Theme(
      data: themeFor(ground, brightness),
      child: Scaffold(
        appBar: AppBar(
          titleSpacing: 0,
          title: InkWell(
            // the work itself, for anyone who arrived from Continue reading
            // and has never seen what they are in the middle of
            onTap: widget.onShowWork,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    widget.work.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: titleFace,
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      color: ground.ink,
                    ),
                  ),
                  if (_total > 1)
                    Text(
                      _chapterName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11.5, color: ground.inkMute),
                    ),
                ],
              ),
            ),
          ),
          actions: [
            /* Where somebody actually decides to leave kudos is the end of a
               chapter, not a shelf. Only offered when there is a session
               behind it: a button that fails when pressed is worse than one
               that is not there. */
            if (widget.downloads?.canAct ?? false)
              IconButton(
                icon: const Icon(Icons.star_outline),
                tooltip: 'On the archive',
                onPressed: () => showArchiveActs(
                  context,
                  downloads: widget.downloads!,
                  work: widget.work,
                ),
              ),
            IconButton(
              icon: const Icon(Icons.text_fields),
              tooltip: 'Type and paper',
              onPressed: _openSettings,
            ),
          ],
        ),
        body: PageView.builder(
          controller: _pages,
          itemCount: _total,
          onPageChanged: _arrived,
          itemBuilder: (context, i) => _ChapterPage(
            key: ValueKey('${widget.work.workId}#${i + 1}'),
            library: widget.library,
            work: widget.work,
            number: i + 1,
            prefs: _prefs,
            ground: ground,
            dark: dark,
            startOffset: i + 1 == widget.startAt ? widget.startOffset : 0,
            pictures: _pictures,
            onScrolled: (at) => _scrolled(i + 1, at),
          ),
        ),
        bottomNavigationBar: _Foot(
          ground: ground,
          chapter: _chapter,
          total: _total,
          through: _through,
          onPrevious: _chapter > 1 ? () => _turn(_chapter - 1) : null,
          onNext: _chapter < _total ? () => _turn(_chapter + 1) : null,
          onPick: widget.chapters.length > 1 ? _pickChapter : null,
        ),
      ),
    );
  }
}

/// One chapter, with its own scroll and its own place in it.
class _ChapterPage extends StatefulWidget {
  const _ChapterPage({
    required this.library,
    required this.work,
    required this.number,
    required this.prefs,
    required this.ground,
    required this.dark,
    required this.startOffset,
    required this.pictures,
    required this.onScrolled,
    super.key,
  });

  final Library library;
  final WorkRow work;
  final int number;
  final core.ReadingPrefs prefs;
  final Ground ground;
  final bool dark;
  final double startOffset;
  final Map<String, ({String mime, Uint8List bytes})> pictures;
  final void Function(ScrollMetrics) onScrolled;

  @override
  State<_ChapterPage> createState() => _ChapterPageState();
}

class _ChapterPageState extends State<_ChapterPage> {
  final ScrollController _scroll = ScrollController();
  late Future<String?> _html;
  bool _restored = false;

  @override
  void initState() {
    super.initState();
    _html = widget.library.chapterHtml(widget.work.workId, widget.number);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _restore() {
    if (_restored || !_scroll.hasClients || widget.startOffset <= 0) return;
    _restored = true;
    _scroll.jumpTo(
      widget.startOffset.clamp(0, _scroll.position.maxScrollExtent),
    );
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<String?>(
    future: _html,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const Center(child: CircularProgressIndicator());
      }
      final html = snapshot.data;
      if (html == null) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Text(
              'That chapter is not here yet.',
              style: TextStyle(color: widget.ground.inkMute),
            ),
          ),
        );
      }

      /* The skin is the work: a chat fic, a letter in another hand. There is
         no being faithful to that without a cascade, so those chapters go to
         the engine the archive renders them with. */
      if (core.needsWebView(skinCss: widget.work.skinCss)) {
        return SkinnedChapterView(
          chapterHtml: html,
          skinCss: widget.work.skinCss,
          pictures: widget.pictures,
          settings: ReadingChrome.from(
            widget.prefs,
            ground: widget.ground,
            dark: widget.dark,
          ),
          plainly: (why) => _plain(html, why),
        );
      }

      WidgetsBinding.instance.addPostFrameCallback((_) => _restore());
      return _plain(html, null);
    },
  );

  /// The chapter as plain text, whatever the work wanted.
  Widget _plain(String html, String? why) {
    final document = core.parseChapter(html);

    /* A chapter that parses to nothing is not an empty screen. It is markup
       this app could not read, or text that never arrived, and either way
       saying so beats a blank page between two bars. */
    if (document.blocks.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text(
            why == null
                ? 'There are no words in this chapter yet. It may not have '
                      'been fetched, or it may be in a shape this reader '
                      'cannot make sense of.'
                : 'This chapter would not render: $why',
            textAlign: TextAlign.center,
            style: TextStyle(color: widget.ground.inkMute, height: 1.5),
          ),
        ),
      );
    }

    return NotificationListener<ScrollNotification>(
      onNotification: (note) {
        if (note.depth == 0) widget.onScrolled(note.metrics);
        return false;
      },
      child: ChapterView(
        document: document,
        settings: ReadingSettings.from(widget.prefs),
        controller: _scroll,
        pictures: widget.pictures,
      ),
    );
  }
}

/// Where you are, and the two ways out of it.
///
/// Always there, even in a one-chapter work: the line of progress is the
/// answer to "how much of this is left", which is a question somebody asks of
/// a short story as readily as of a long one.
class _Foot extends StatelessWidget {
  const _Foot({
    required this.ground,
    required this.chapter,
    required this.total,
    required this.through,
    required this.onPrevious,
    required this.onNext,
    required this.onPick,
  });

  final Ground ground;
  final int chapter;
  final int total;
  final double through;
  final VoidCallback? onPrevious;
  final VoidCallback? onNext;
  final VoidCallback? onPick;

  @override
  Widget build(BuildContext context) => Container(
    color: ground.surface,
    child: SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          LinearProgressIndicator(
            value: through,
            minHeight: 2,
            backgroundColor: ground.lineSoft,
            color: ground.accent,
          ),
          SizedBox(
            height: 50,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                IconButton(
                  onPressed: onPrevious,
                  icon: const Icon(Icons.chevron_left),
                  tooltip: 'Previous chapter',
                ),
                TextButton(
                  onPressed: onPick,
                  child: Text(
                    total > 1 ? '$chapter of $total' : 'One chapter',
                    style: TextStyle(color: ground.inkMid),
                  ),
                ),
                IconButton(
                  onPressed: onNext,
                  icon: const Icon(Icons.chevron_right),
                  tooltip: 'Next chapter',
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}
