import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart';

import 'activity_screen.dart';
import 'add_sheet.dart';
import 'blocked_screen.dart';
import 'downloads.dart';
import 'home_screen.dart';
import 'keep_working.dart';
import 'library.dart';
import 'filter_sheet.dart';
import 'person_screen.dart';
import 'reader_screen.dart';
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
  KeepWorking.prepare();
  runApp(const FolioApp());
}

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
  final GlobalKey<YouScreenState> _you = GlobalKey<YouScreenState>();
  Library? _library;
  Downloads? _downloads;
  KeepWorking? _keepWorking;
  bool _loading = true;
  String? _trouble;
  int _tab = 0;

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
    if (to == _tab) return;
    setState(() {
      _trail.add(_tab);
      if (_trail.length > 20) _trail.removeAt(0);
      _tab = to;
      if (to == 1 && _viewTitle == 'Library') {
        _view = const {'sort': 'added'};
      }
    });
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
      final library = await Library.openExisting();
      final session = await Session.load();
      if (!mounted) return;
      setState(() {
        _library = library;
        _downloads = library == null
            ? null
            : Downloads(library: library, session: session);
        _keepWorking = _downloads == null ? null : KeepWorking(_downloads!);
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

  void _adopt(Library library) {
    // whoever was signed in still is: the session is kept beside the library
    // rather than inside it, so importing one does not sign anybody out
    final session = _downloads?.session ?? Session.none;
    _keepWorking?.dispose();
    _downloads?.dispose();
    final downloads = Downloads(library: library, session: session);
    setState(() {
      _library = library;
      _downloads = downloads;
      _keepWorking = KeepWorking(downloads);
      _loading = false;
    });
  }

  @override
  void dispose() {
    _keepWorking?.dispose();
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
    await showAddByLink(context, downloads);
  }

  /// The things that are about the library rather than about a work.
  ///
  /// They were in an overflow menu, which is where things go when nobody has
  /// decided where they belong — and backing up has no business being three
  /// taps behind a caret when it is the one action that protects the rest.
  Future<void> _openSettings(Library library) async {
    await Navigator.of(context).push(
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
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ActivityScreen(downloads: downloads),
      ),
    );
  }

  /// Open a work at its own page.
  ///
  /// Which is where a work should start. Dropping straight into chapter one
  /// left nowhere to read what a work is before reading it, no way to reach
  /// chapter nine, and no way out of a work except backwards.
  Future<void> _open(WorkRow work) async {
    final library = _library;
    if (library == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => WorkScreen(
          library: library,
          workId: work.workId,
          downloads: _downloads,
          onRead: _read,
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
  Future<void> _resume(WorkRow work, {int chapter = 1}) async {
    final library = _library;
    if (library == null) return;
    final chapters = await library.chapters(work.workId);
    if (!mounted) return;
    await _read(work, chapters, chapter);
  }

  Future<void> _read(
    WorkRow work,
    List<ChapterRow> chapters,
    int chapter,
  ) async {
    final library = _library;
    if (library == null) return;
    final place = await library.placeIn(work.workId);
    final at = chapter > 1 ? chapter : (place?.chapter ?? 1);
    if (!mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ReaderScreen(
          library: library,
          work: work,
          chapters: chapters,
          downloads: _downloads,
          onShowWork: () => _open(work),
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
  }

  /// One person, which a byline had no way of being until now.
  Future<void> _openPerson(String byline) async {
    final library = _library;
    if (library == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => PersonScreen(
          library: library,
          byline: byline,
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
    final changed = await Navigator.of(context).push<bool>(
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

  /// A shelf's See all lands on the same question the shelf asked.
  void _seeAll(Map<String, Object?> view, String title) {
    if (_tab != 1) {
      _trail.add(_tab);
      if (_trail.length > 20) _trail.removeAt(0);
    }
    setState(() {
      _view = view;
      _viewTitle = title;
      _tab = 1;
    });
  }

  /// What the bar says it is showing.
  String get _title => switch (_tab) {
    0 => 'Fan Folio',
    2 => 'You',
    _ => _viewTitle,
  };

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
      canPop: _trail.isEmpty,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: _shell(library, ground),
    );
  }

  Widget _shell(Library library, Ground ground) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_title),
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
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            tooltip: 'Settings',
            onPressed: () => _openSettings(library),
          ),
        ],
      ),
      body: _tab == 2
          ? YouScreen(
              key: _you,
              library: library,
              downloads: _downloads,
              onNarrow: _seeAll,
              onBlocked: () => _openBlocked(library),
            )
          : _tab == 0
          ? HomeScreen(
              key: _home,
              library: library,
              onOpen: _open,
              onResume: _resume,
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
              onPerson: _openPerson,
            ),
      floatingActionButton: _tab == 2
          ? null
          : FloatingActionButton(
              onPressed: _add,
              tooltip: 'Add a work',
              child: const Icon(Icons.add),
            ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: _goToTab,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), label: 'Home'),
          NavigationDestination(
            icon: Icon(Icons.menu_book_outlined),
            label: 'Library',
          ),
          /* Signing in lived behind a gear, which is where a thing goes when
             nobody has decided it matters — and it is the gate for half of
             what this app can do. */
          NavigationDestination(icon: Icon(Icons.person_outline), label: 'You'),
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
    this.onPerson,
    super.key,
  });

  final Library library;
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
      final picked = await FilePicker.pickFile();
      if (picked == null) {
        setState(() => _working = false);
        return;
      }
      // streamed in: a file from the system picker often has no path at all,
      // and a library worth keeping is too big to read into memory
      final library = await Library.importFromStream(picked.readAsByteStream());
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
