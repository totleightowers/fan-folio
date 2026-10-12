import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart';

import 'activity_screen.dart';
import 'app_destination.dart';
import 'add_sheet.dart';
import 'blocked_screen.dart';
import 'downloads.dart';
import 'discovery_store.dart';
import 'explore_screen.dart';
import 'home_screen.dart';
import 'keep_working.dart';
import 'remote_downloads.dart';
import 'library.dart';
import 'filter_sheet.dart';
import 'person_screen.dart';
import 'reader_screen.dart';
import 'return_to_story.dart';
import 'search_screen.dart';
import 'session.dart';
import 'settings_screen.dart';
import 'theme.dart';
import 'work_actions.dart';
import 'work_card.dart';
import 'work_screen.dart';
import 'you_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  // set up before anything can ask for it; nothing is shown until there is
  // work, and nobody is asked for permission until then either
  prepareDownloadService();
  runApp(const FolioApp());
}

Downloads _downloadsFor(Library library, Session session) =>
    supportsDownloadService
    ? RemoteDownloads(library: library, session: session)
    : Downloads(library: library, session: session);

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

/// Independent browsing histories with a full-screen reader above them.
class Shell extends StatefulWidget {
  const Shell({this.initialLibrary, this.initialDownloads, super.key});

  final Library? initialLibrary;
  final Downloads? initialDownloads;

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  final GlobalKey<HomeScreenState> _home = GlobalKey<HomeScreenState>();
  final GlobalKey<YouScreenState> _you = GlobalKey<YouScreenState>();
  List<GlobalKey<NavigatorState>> _navigators = List.generate(
    4,
    (_) => GlobalKey<NavigatorState>(),
  );
  NavigatorState get _navigator => _navigators[_tab].currentState!;

  void _routeChanged() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() {});
    });
  }

  Library? _library;
  Downloads? _downloads;
  bool _loading = true;
  String? _trouble;
  int _tab = 0;
  WorkRow? _lastStory;
  int _lastChapter = 1;
  int _savedCount = 0;

  // what the Library tab is currently narrowed to
  Map<String, Object?> _view = const {'sort': 'added'};
  String _viewTitle = 'Library';

  /// Bumped when something leaves the library, so the list rebuilds from the
  /// database rather than from the page of works it happens to be holding.
  int _libraryEpoch = 0;

  /// The tabs behind this one.
  ///
  /// Tabs are not routes, so back at the root leaves the app — which is the
  /// right answer for somebody who opened it on Home and pressed back, and
  /// the wrong one for somebody who went Home, Library, You and expected to
  /// walk back out the way they came. Capped, because a trail is a way back
  /// and not a history.
  final List<int> _trail = [];

  void _goToTab(int to) {
    if (to == _tab) {
      _navigators[to].currentState?.popUntil((route) => route.isFirst);
      return;
    }
    setState(() {
      _trail.add(_tab);
      if (_trail.length > 20) _trail.removeAt(0);
      _tab = to;
      if (to == 2) _libraryEpoch++;
    });
    if (to == 0) unawaited(_home.currentState?.reload());
    if (to == 3) unawaited(_you.currentState?.reload());
  }

  /// Back: the tab before this one, or out of the app if there is none.
  bool _back() {
    if (_trail.isEmpty) return false;
    setState(() => _tab = _trail.removeLast());
    return true;
  }

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final library = widget.initialLibrary ?? await Library.openExisting();
      final session = widget.initialDownloads?.session ?? await Session.load();
      final downloads =
          widget.initialDownloads ??
          (library == null ? null : _downloadsFor(library, session));
      if (widget.initialDownloads == null) await downloads?.restore();
      if (!mounted) return;
      setState(() {
        _library = library;
        _downloads = downloads;
        _downloads?.addListener(_downloadsChanged);
        _loading = false;
      });
      /* Present as the browser this device has, and carry the cookies it is
         holding now. Both are what 1.x did, and both were lost in the port:
         a made-up agent and a snapshot from sign-in is a request that matches
         nothing the archive knows about us. */
      if (widget.initialDownloads == null) {
        await _downloads?.useThisDevicesAgent();
        await _downloads?.refreshCookies();
      }
      _downloads?.start();
      await _reloadStory();
    } catch (e) {
      if (!mounted) return;
      // say what actually went wrong; a blank screen teaches nobody anything
      setState(() {
        _loading = false;
        _trouble = '$e';
      });
    }
  }

  Future<void> _adopt(Library library) async {
    // whoever was signed in still is: the session is kept beside the library
    // rather than inside it, so importing one does not sign anybody out
    final session = _downloads?.session ?? Session.none;
    _downloads?.removeListener(_downloadsChanged);
    await _downloads?.flush();
    _downloads?.dispose();
    final downloads = _downloadsFor(library, session);
    await downloads.restore();
    await downloads.useThisDevicesAgent();
    await downloads.refreshCookies();
    downloads.addListener(_downloadsChanged);
    if (!mounted) {
      downloads.dispose();
      return;
    }
    setState(() {
      _navigators = List.generate(4, (_) => GlobalKey<NavigatorState>());
      _trail.clear();
      _tab = 0;
      _library = library;
      _downloads = downloads;
      _loading = false;
      _lastStory = null;
      _libraryEpoch++;
    });
    downloads.start();
    await _reloadStory();
  }

  Future<void> _reloadStory() async {
    final library = _library;
    if (library == null) return;
    final work = await library.returnToStory();
    final place = work == null ? null : await library.placeIn(work.workId);
    if (!mounted || library != _library) return;
    setState(() {
      _lastStory = work;
      _lastChapter = place?.chapter ?? 1;
    });
  }

  void _downloadsChanged() {
    if (!mounted) return;
    final saved = _downloads?.jobs.fold<int>(0, (n, job) => n + job.added) ?? 0;
    if (saved == _savedCount) return;
    _savedCount = saved;
    unawaited(_home.currentState?.reload());
    setState(() => _libraryEpoch++);
  }

  @override
  void dispose() {
    _downloads?.removeListener(_downloadsChanged);
    _downloads?.dispose();
    super.dispose();
  }

  /// Queue a work by link.
  ///
  /// Nothing is redrawn afterwards on purpose: the work is queued, not here —
  /// it arrives a request later, at a reader's pace rather than a scraper's.
  /// Activity is where that can be watched.
  Future<void> _add() async {
    final downloads = _downloads;
    if (downloads == null) return;
    final added = await showAddByLink(context, downloads);
    if (added && mounted) _openActivity();
  }

  /// The things that are about the library rather than about a work.
  ///
  /// They were in an overflow menu, which is where things go when nobody has
  /// decided where they belong — and backing up has no business being three
  /// taps behind a caret when it is the one action that protects the rest.
  Future<void> _openSettings(Library library) async {
    await _navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => SettingsScreen(
          library: library,
          downloads: _downloads,
          onImported: _adopt,
          onBlocked: () => _openBlocked(library),
          onActivity: _openActivity,
        ),
      ),
    );
    if (!mounted) return;
    // a library brought in, or an author unblocked, is a different shelf
    await _home.currentState?.reload();
    await _you.currentState?.reload();
    setState(() => _libraryEpoch++);
  }

  void _openActivity() {
    final downloads = _downloads;
    if (downloads == null) return;
    _navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => ActivityScreen(downloads: downloads, onOpen: _openById),
      ),
    );
  }

  /// Open a work at its own page.
  ///
  /// Which is where a work should start. Dropping straight into chapter one
  /// left nowhere to read what a work is before reading it, no way to reach
  /// chapter nine, and no way out of a work except backwards.
  Future<void> _open(WorkRow work, {Blurb? preview}) async {
    final library = _library;
    if (library == null) return;
    await _navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => WorkScreen(
          library: library,
          workId: work.workId,
          preview: preview,
          onExplore: _explore,
          onDownloads: _openActivity,
          downloads: _downloads,
          onRead: (work, chapters, chapter) =>
              _read(work, chapters, chapter, fromWork: true),
          onPerson: _openPerson,
          onNarrow: _seeAll,
        ),
      ),
    );
    if (!mounted) return;
    // reading, deleting or blocking from in there changes what Home says
    await _home.currentState?.reload();
    await _you.currentState?.reload();
    setState(() => _libraryEpoch++);
  }

  /// Straight into the text.
  ///
  /// What Continue reading is for: a shelf that says "carry on" and then
  /// shows a description is not carrying on. Everything else arrives at the
  /// work's own page first and comes through here afterwards.
  Future<void> _resume(WorkRow work, {int? chapter}) async {
    final library = _library;
    if (library == null) return;
    final full = await library.work(work.workId);
    final chapters = await library.chapters(work.workId);
    final place = await library.placeIn(work.workId);
    if (!mounted || full == null) return;
    await _read(full, chapters, chapter ?? place?.chapter ?? 1);
  }

  Future<void> _read(
    WorkRow work,
    List<ChapterRow> chapters,
    int chapter, {
    bool fromWork = false,
  }) async {
    final library = _library;
    if (library == null) return;
    final place = await library.placeIn(work.workId);
    final at = chapter.clamp(1, chapters.isEmpty ? 1 : chapters.last.number);
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ReaderScreen(
          library: library,
          work: work,
          chapters: chapters,
          downloads: _downloads,
          onShowWork: () {
            Navigator.of(context).pop();
            if (!fromWork) _open(work);
          },
          onNavigate: _navigateFromReader,
          startAt: at,
          startOffset: openingOffset(
            chapter: at,
            savedChapter: place?.chapter,
            savedOffset: place?.offset,
          ),
        ),
      ),
    );
    if (!mounted) return;
    // reading changes what Home has to say about itself
    await _home.currentState?.reload();
    await _reloadStory();
  }

  void _navigateFromReader(AppDestination destination) {
    final library = _library;
    if (library == null) return;
    // Work and author pages can be underneath the reader. Leave that whole
    // stack so the selected destination is visible immediately.
    Navigator.of(context).popUntil((route) => route.isFirst);
    switch (destination) {
      case AppDestination.home:
        _goToTab(0);
        _navigators[0].currentState?.popUntil((route) => route.isFirst);
      case AppDestination.explore:
        _goToTab(1);
      case AppDestination.library:
        _goToTab(2);
        _navigators[2].currentState?.popUntil((route) => route.isFirst);
      case AppDestination.downloads:
        _openActivity();
      case AppDestination.you:
        _goToTab(3);
      case AppDestination.search:
        _openSearch(library);
      case AppDestination.settings:
        _openSettings(library);
    }
  }

  void _openSearch(Library library) {
    _navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => SearchScreen(
          library: library,
          onDownloads: _openActivity,
          onOpen: (workId, {int chapter = 1}) =>
              _openById(workId, chapter: chapter),
        ),
      ),
    );
  }

  /// One person, which a byline had no way of being until now.
  Future<void> _openPerson(String byline) async {
    final library = _library;
    if (library == null) return;
    await _navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => PersonScreen(
          library: library,
          byline: byline,
          onDownloads: _openActivity,
          onExplore: () => _explore(ArchiveSearch(author: byline)),
          downloads: _downloads,
          onOpen: _open,
          onNarrow: _seeAll,
        ),
      ),
    );
    if (!mounted) return;
    // blocking or fetching from in there changes what the shelves hold
    await _home.currentState?.reload();
    await _you.currentState?.reload();
    setState(() => _libraryEpoch++);
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
      downloads: _downloads,
    );
    if (!changed || !mounted) return;
    await _home.currentState?.reload();
    await _you.currentState?.reload();
    setState(() => _libraryEpoch++);
  }

  Future<void> _openBlocked(Library library) async {
    final changed = await _navigator.push<bool>(
      MaterialPageRoute<bool>(builder: (_) => BlockedScreen(library: library)),
    );
    if (changed != true || !mounted) return;
    // unblocking puts works back, which is the shelves and the list both
    await _home.currentState?.reload();
    await _you.currentState?.reload();
    setState(() => _libraryEpoch++);
  }

  Future<void> _openById(String workId, {int chapter = 1}) async {
    final work = await _library?.work(workId);
    if (work == null) return;
    // a search result is a passage, so it opens at the passage
    if (chapter > 1) {
      await _resume(work, chapter: chapter);
    } else {
      await _open(work);
    }
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

  /// Open an archive query without discarding the results behind it.
  void _explore(ArchiveSearch search) {
    final library = _library;
    final downloads = _downloads;
    if (library == null || downloads == null) return;
    _navigator.push(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(
            title: const Text('Explore AO3'),
            actions: [_downloadButton()],
          ),
          body: ExploreScreen(
            library: library,
            downloads: downloads,
            initialSearch: search,
            onOpen: (b) => _open(workFromBlurb(b), preview: b),
            onLibrarySearch: () => _openSearch(library),
          ),
        ),
      ),
    );
  }

  void _seeAll(Map<String, Object?> view, String title) {
    _goToTab(2);
    _navigators[2].currentState?.popUntil((route) => route.isFirst);
    setState(() {
      _view = view;
      _viewTitle = title;
    });
  }

  Widget _downloadButton() => IconButton(
    tooltip: 'Downloads',
    icon: const Icon(Icons.download_outlined),
    onPressed: _openActivity,
  );

  Widget _rootPage(int tab, Library library) => Scaffold(
    appBar: AppBar(
      title: Text(['Home', 'Explore', _viewTitle, 'You'][tab]),
      actions: [
        if (tab == 2)
          IconButton(
            icon: Badge(
              isLabelVisible: _narrowed,
              label: Text('$_narrowCount'),
              child: const Icon(Icons.filter_alt_outlined),
            ),
            tooltip: 'Filters',
            onPressed: () => _openFilters(library),
          ),
        if (tab != 1)
          IconButton(
            icon: const Icon(Icons.search),
            tooltip: 'Search library',
            onPressed: () => _openSearch(library),
          ),
        _downloadButton(),
        IconButton(
          icon: const Icon(Icons.settings_outlined),
          tooltip: 'Settings',
          onPressed: () => _openSettings(library),
        ),
      ],
    ),
    body: switch (tab) {
      0 => HomeScreen(
        key: _home,
        library: library,
        onOpen: _open,
        onResume: _resume,
        onHold: _actOn,
        onSeeAll: _seeAll,
        onNarrow: _seeAll,
        onOpenById: _openById,
      ),
      1 => ExploreScreen(
        library: library,
        downloads: _downloads!,
        onOpen: (b) => _open(workFromBlurb(b), preview: b),
        onLibrarySearch: () => _openSearch(library),
      ),
      2 => LibraryList(
        library: library,
        view: _view,
        refreshEpoch: _libraryEpoch,
        onOpen: _open,
        onHold: _actOn,
        onPerson: _openPerson,
      ),
      _ => YouScreen(
        key: _you,
        library: library,
        downloads: _downloads,
        onNarrow: _seeAll,
        onBlocked: () => _openBlocked(library),
      ),
    },
    floatingActionButton: tab == 3 || tab == 1
        ? null
        : FloatingActionButton(
            heroTag: null,
            onPressed: _add,
            tooltip: 'Add a work',
            child: const Icon(Icons.add),
          ),
  );

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

    return PopScope(
      canPop:
          _trail.isEmpty &&
          !(_navigators[_tab].currentState?.canPop() ?? false),
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) {
          final navigator = _navigators[_tab].currentState;
          if (navigator?.canPop() ?? false) {
            navigator!.pop();
          } else {
            _back();
          }
        }
      },
      child: _shell(library, ground),
    );
  }

  Widget _shell(Library library, Ground ground) {
    final wide = MediaQuery.sizeOf(context).width >= 720;
    final destinations = const [
      NavigationDestination(icon: Icon(Icons.home_outlined), label: 'Home'),
      NavigationDestination(
        icon: Icon(Icons.explore_outlined),
        label: 'Explore',
      ),
      NavigationDestination(
        icon: Icon(Icons.menu_book_outlined),
        label: 'Library',
      ),
      NavigationDestination(icon: Icon(Icons.person_outline), label: 'You'),
    ];
    final page = Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [
          for (var i = 0; i < 4; i++)
            TickerMode(
              enabled: i == _tab,
              child: Navigator(
                key: _navigators[i],
                observers: [_HistoryObserver(_routeChanged)],
                pages: [
                  MaterialPage<void>(
                    key: ValueKey('root-$i'),
                    child: _rootPage(i, library),
                  ),
                ],
                onDidRemovePage: (_) {},
              ),
            ),
        ],
      ),
      bottomNavigationBar: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_lastStory != null)
            ReturnToStory(
              work: _lastStory!,
              chapter: _lastChapter,
              onResume: () => _resume(_lastStory!),
            ),
          if (!wide)
            NavigationBar(
              selectedIndex: _tab,
              onDestinationSelected: _goToTab,
              destinations: destinations,
            ),
        ],
      ),
    );
    if (!wide) return page;
    return Row(
      children: [
        SafeArea(
          child: NavigationRail(
            selectedIndex: _tab,
            labelType: NavigationRailLabelType.all,
            onDestinationSelected: _goToTab,
            destinations: [
              for (final d in destinations)
                NavigationRailDestination(icon: d.icon, label: Text(d.label)),
            ],
          ),
        ),
        const VerticalDivider(width: 1),
        Expanded(child: page),
      ],
    );
  }
}

class _HistoryObserver extends NavigatorObserver {
  _HistoryObserver(this.changed);
  final VoidCallback changed;
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      changed();
  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => changed();
  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      changed();
}

/// Everything held, under whatever narrowing is in force.
class LibraryList extends StatefulWidget {
  const LibraryList({
    required this.library,
    required this.view,
    required this.onOpen,
    this.onHold,
    this.onPerson,
    this.refreshEpoch = 0,
    super.key,
  });

  final Library library;
  final int refreshEpoch;
  final Map<String, Object?> view;
  final void Function(WorkRow) onOpen;
  final void Function(WorkRow)? onHold;
  final void Function(String byline)? onPerson;

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
  int _generation = 0;

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
    if (old.view != widget.view || old.library != widget.library) {
      _reload();
    } else if (old.refreshEpoch != widget.refreshEpoch) {
      _reload(preserve: true);
    }
  }

  Future<void> _reload({bool preserve = false}) async {
    final generation = ++_generation;
    final limit = preserve && _works.length > _pageSize
        ? _works.length
        : _pageSize;
    setState(() {
      _loading = true;
      if (!preserve) _works.clear();
    });
    if (!preserve && _scroll.hasClients) _scroll.jumpTo(0);
    final total = await widget.library.count(widget.view);
    final page = await widget.library.works({
      ...widget.view,
      'limit': limit,
      'offset': 0,
    });
    if (!mounted || generation != _generation) return;
    setState(() {
      _total = total;
      _works
        ..clear()
        ..addAll(page);
      _more = _works.length < _total;
      _loading = false;
    });
  }

  Future<void> _loadMore() async {
    if (!_more || _loading) return;
    final generation = _generation;
    setState(() => _loading = true);
    final page = await widget.library.works({
      ...widget.view,
      'limit': _pageSize,
      'offset': _works.length,
    });
    if (!mounted || generation != _generation) return;
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
                onPerson: widget.onPerson,
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
  final Future<void> Function(Library) onImported;

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
      final picked = await FilePicker.pickFile();
      if (picked == null) {
        setState(() => _working = false);
        return;
      }
      // streamed in: a file from the system picker often has no path at all,
      // and a library worth keeping is too big to read into memory
      final library = await Library.importFromStream(picked.readAsByteStream());
      if (!mounted) return;
      await widget.onImported(library);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _working = false;
        _trouble = '$e';
      });
    }
  }

  Future<void> _startEmpty() async {
    setState(() => _working = true);
    try {
      final library = await Library.create();
      if (mounted) await widget.onImported(library);
    } catch (e) {
      if (mounted) {
        setState(() {
          _working = false;
          _trouble = '$e';
        });
      }
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
            'Fan Folio Preview',
            style: TextStyle(
              fontFamily: titleFace,
              fontSize: 22,
              fontWeight: FontWeight.w600,
              color: widget.ground.ink,
            ),
          ),
          const SizedBox(height: 10),
          Text(
            'An early Flutter preview with its own library. Your current Fan Folio '
            'stays installed. Start empty, or bring in a copy of a library backup.',
            textAlign: TextAlign.center,
            style: TextStyle(color: widget.ground.inkMute, height: 1.5),
          ),
          const SizedBox(height: 22),
          FilledButton(
            onPressed: _working ? null : _bringOneIn,
            child: Text(_working ? 'Bringing it in…' : 'Bring in a backup'),
          ),
          TextButton(
            onPressed: _working ? null : _startEmpty,
            child: const Text('Start an empty library'),
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
