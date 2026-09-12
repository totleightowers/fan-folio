import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart';

import 'blocked_screen.dart';
import 'home_screen.dart';
import 'library.dart';
import 'filter_sheet.dart';
import 'reader_screen.dart';
import 'search_screen.dart';
import 'theme.dart';
import 'work_actions.dart';
import 'work_card.dart';

void main() => runApp(const FolioApp());

class FolioApp extends StatelessWidget {
  const FolioApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Fan Folio',
    debugShowCheckedModeBanner: false,
    theme: themeFor(Ground.light, Brightness.light),
    darkTheme: themeFor(Ground.dark, Brightness.dark),
    home: const Shell(),
  );
}

/// The app, and the two places it is made of.
///
/// Home is what you came back for; the Library is everything. Search is an
/// action from either rather than a third place, because "search" is something
/// you do to a library, not somewhere you go.
class Shell extends StatefulWidget {
  const Shell({super.key});

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  final GlobalKey<HomeScreenState> _home = GlobalKey<HomeScreenState>();
  Library? _library;
  bool _loading = true;
  String? _trouble;
  int _tab = 0;

  // what the Library tab is currently narrowed to
  Map<String, Object?> _view = const {'sort': 'added'};
  String _viewTitle = 'Library';

  /// Bumped when something leaves the library, so the list rebuilds from the
  /// database rather than from the page of works it happens to be holding.
  int _libraryEpoch = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final library = await Library.openExisting();
      if (!mounted) return;
      setState(() {
        _library = library;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      // say what actually went wrong; a blank screen teaches nobody anything
      setState(() {
        _loading = false;
        _trouble = '$e';
      });
    }
  }

  void _adopt(Library library) => setState(() {
    _library = library;
    _loading = false;
  });

  Future<void> _open(WorkRow work, {int chapter = 1}) async {
    final library = _library;
    if (library == null) return;
    final chapters = await library.chapters(work.workId);
    final place = await library.placeIn(work.workId);
    final at = chapter > 1 ? chapter : (place?.chapter ?? 1);
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ReaderScreen(
          library: library,
          work: work,
          chapters: chapters,
          startAt: at,
          startOffset: openingOffset(
            chapter: at,
            savedChapter: place?.chapter,
            savedOffset: place?.offset,
          ),
        ),
      ),
    );
    // reading changes what Home has to say about itself
    await _home.currentState?.reload();
  }

  /// Holding a work offers what you can do to it other than read it.
  ///
  /// Both of those — deleting and blocking — change what the shelves and the
  /// library have to say, so whichever of them is on screen is asked again
  /// afterwards rather than left showing a work that is no longer there.
  Future<void> _actOn(WorkRow work) async {
    final library = _library;
    if (library == null) return;
    final changed = await showWorkActions(
      context,
      library: library,
      work: work,
    );
    if (!changed || !mounted) return;
    await _home.currentState?.reload();
    setState(() => _libraryEpoch++);
  }

  Future<void> _openBlocked(Library library) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(builder: (_) => BlockedScreen(library: library)),
    );
    if (changed != true || !mounted) return;
    // unblocking puts works back, which is the shelves and the list both
    await _home.currentState?.reload();
    setState(() => _libraryEpoch++);
  }

  Future<void> _openById(String workId, {int chapter = 1}) async {
    final work = await _library?.work(workId);
    if (work != null) await _open(work, chapter: chapter);
  }

  /// How many filters are in force, which is what the badge counts.
  int get _narrowCount {
    var n = 0;
    for (final key in ['include', 'exclude', 'rating', 'author']) {
      n += (_view[key] as List?)?.length ?? 0;
    }
    for (final key in ['complete', 'language', 'wordsMax', 'bookmarkedBy']) {
      if (_view[key] != null) n++;
    }
    if ((_view['state'] ?? 'all') != 'all') n++;
    return n;
  }

  bool get _narrowed => _narrowCount > 0;

  Future<void> _openFilters(Library library) async {
    final chosen = await showModalBottomSheet<Map<String, Object?>>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => FilterSheet(library: library, view: _view),
    );
    if (chosen == null || !mounted) return;
    setState(() {
      _view = chosen;
      _viewTitle = 'Library';
    });
  }

  /// A shelf's See all lands on the same question the shelf asked.
  void _seeAll(Map<String, Object?> view, String title) => setState(() {
    _view = view;
    _viewTitle = title;
    _tab = 1;
  });

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final library = _library;

    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_trouble != null) {
      return Scaffold(
        body: _Message(text: _trouble!, ground: ground),
      );
    }
    if (library == null) {
      return Scaffold(
        body: _NoLibrary(ground: ground, onImported: _adopt),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(_tab == 0 ? 'Fan Folio' : _viewTitle),
        actions: [
          if (_tab == 1)
            IconButton(
              icon: Badge(
                isLabelVisible: _narrowed,
                label: Text('$_narrowCount'),
                child: const Icon(Icons.filter_list),
              ),
              tooltip: 'Filters',
              onPressed: () => _openFilters(library),
            ),
          IconButton(
            icon: const Icon(Icons.search),
            tooltip: 'Search',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => SearchScreen(
                  library: library,
                  onOpen: (workId, {int chapter = 1}) =>
                      _openById(workId, chapter: chapter),
                ),
              ),
            ),
          ),
          PopupMenuButton<void>(
            itemBuilder: (context) => [
              PopupMenuItem<void>(
                onTap: () => _openBlocked(library),
                child: const Text('Blocked authors'),
              ),
            ],
          ),
        ],
      ),
      body: _tab == 0
          ? HomeScreen(
              key: _home,
              library: library,
              onOpen: _open,
              onHold: _actOn,
              onSeeAll: _seeAll,
              onNarrow: _seeAll,
              onOpenById: _openById,
            )
          : LibraryList(
              key: ValueKey(_libraryEpoch),
              library: library,
              view: _view,
              onOpen: _open,
              onHold: _actOn,
            ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() {
          _tab = i;
          if (i == 1 && _viewTitle == 'Library') {
            _view = const {'sort': 'added'};
          }
        }),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), label: 'Home'),
          NavigationDestination(
            icon: Icon(Icons.menu_book_outlined),
            label: 'Library',
          ),
        ],
      ),
    );
  }
}

/// Everything held, under whatever narrowing is in force.
class LibraryList extends StatefulWidget {
  const LibraryList({
    required this.library,
    required this.view,
    required this.onOpen,
    this.onHold,
    super.key,
  });

  final Library library;
  final Map<String, Object?> view;
  final void Function(WorkRow) onOpen;
  final void Function(WorkRow)? onHold;

  @override
  State<LibraryList> createState() => _LibraryListState();
}

class _LibraryListState extends State<LibraryList> {
  static const int _pageSize = 60;

  final ScrollController _scroll = ScrollController();
  final List<WorkRow> _works = [];
  int _total = 0;
  bool _loading = true;
  bool _more = true;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadMore);
    _reload();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(LibraryList old) {
    super.didUpdateWidget(old);
    if (old.view != widget.view) _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _works.clear();
      _more = true;
    });
    final total = await widget.library.count(widget.view);
    if (!mounted) return;
    setState(() => _total = total);
    await _loadMore();
  }

  /// A library of eight thousand works is not a list you hand somebody whole.
  ///
  /// It used to ask for two hundred and stop, which on a real library is
  /// "showing 200 of 8030" and no way to reach the rest.
  Future<void> _loadMore() async {
    if (!_more) return;
    final page = await widget.library.works({
      ...widget.view,
      'limit': _pageSize,
      'offset': _works.length,
    });
    if (!mounted) return;
    setState(() {
      _works.addAll(page);
      _more = page.length == _pageSize && _works.length < _total;
      _loading = false;
    });
  }

  void _maybeLoadMore() {
    if (_loading || !_more || !_scroll.hasClients) return;
    // a screen and a half ahead, so the next page is there before the bottom is
    final ahead = _scroll.position.viewportDimension * 1.5;
    if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - ahead) {
      _loadMore();
    }
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    if (_loading && _works.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_works.isEmpty) {
      return _Message(text: 'Nothing matches.', ground: ground);
    }
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 2),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text(
              '$_total works',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
          ),
        ),
        Expanded(
          child: ListView.separated(
            controller: _scroll,
            itemCount: _works.length + (_more ? 1 : 0),
            separatorBuilder: (_, __) =>
                Divider(height: 1, color: ground.lineSoft),
            itemBuilder: (context, i) {
              if (i >= _works.length) {
                return const Padding(
                  padding: EdgeInsets.symmetric(vertical: 20),
                  child: Center(child: CircularProgressIndicator()),
                );
              }
              return WorkRowTile(
                work: _works[i],
                onTap: () => widget.onOpen(_works[i]),
                onLongPress: widget.onHold == null
                    ? null
                    : () => widget.onHold!(_works[i]),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.text, required this.ground});

  final String text;
  final Ground ground;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: TextStyle(color: ground.inkMute, height: 1.5),
      ),
    ),
  );
}

/// Nothing here yet, and the way to change that.
///
/// This build keeps its own library, separate from the 1.x app's, because
/// Android gives every application its own private storage and one cannot read
/// another's. So a library arrives the way it leaves: as a backup, handed over.
class _NoLibrary extends StatefulWidget {
  const _NoLibrary({required this.ground, required this.onImported});

  final Ground ground;
  final void Function(Library) onImported;

  @override
  State<_NoLibrary> createState() => _NoLibraryState();
}

class _NoLibraryState extends State<_NoLibrary> {
  bool _working = false;
  String? _trouble;

  Future<void> _bringOneIn() async {
    setState(() {
      _working = true;
      _trouble = null;
    });
    try {
      // deliberately not filtered by extension: a backup arrives named all
      // sorts of things, and a picker that hides the file somebody is looking
      // straight at is worse than one that shows too much
      final picked = await FilePicker.platform.pickFiles(withData: false);
      final path = picked?.files.single.path;
      if (path == null) {
        setState(() => _working = false);
        return;
      }
      final library = await Library.importFrom(path);
      if (!mounted) return;
      widget.onImported(library);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _working = false;
        _trouble = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'No library here yet',
            style: TextStyle(
              fontFamily: titleFace,
              fontSize: 22,
              fontWeight: FontWeight.w600,
              color: widget.ground.ink,
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'This build keeps its own library, separate from the one your 1.x '
            'app has, so nothing you rely on is touched. Back up from there '
            'and bring the file in here.',
            textAlign: TextAlign.center,
            style: TextStyle(color: widget.ground.inkMute, height: 1.5),
          ),
          const SizedBox(height: 22),
          FilledButton(
            onPressed: _working ? null : _bringOneIn,
            child: Text(_working ? 'Bringing it in…' : 'Bring in a backup'),
          ),
          if (_trouble != null) ...[
            const SizedBox(height: 16),
            Text(
              _trouble!,
              textAlign: TextAlign.center,
              style: TextStyle(color: widget.ground.inkMute, fontSize: 13),
            ),
          ],
        ],
      ),
    ),
  );
}
