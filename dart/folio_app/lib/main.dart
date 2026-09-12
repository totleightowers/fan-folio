import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart';

import 'home_screen.dart';
import 'library.dart';
import 'reader_screen.dart';
import 'search_screen.dart';
import 'theme.dart';
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

  Future<void> _openById(String workId, {int chapter = 1}) async {
    final work = await _library?.work(workId);
    if (work != null) await _open(work, chapter: chapter);
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
        ],
      ),
      body: _tab == 0
          ? HomeScreen(
              key: _home,
              library: library,
              onOpen: _open,
              onSeeAll: _seeAll,
            )
          : LibraryList(library: library, view: _view, onOpen: _open),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() {
          _tab = i;
          if (i == 1 && _viewTitle == 'Library')
            _view = const {'sort': 'added'};
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
    super.key,
  });

  final Library library;
  final Map<String, Object?> view;
  final void Function(WorkRow) onOpen;

  @override
  State<LibraryList> createState() => _LibraryListState();
}

class _LibraryListState extends State<LibraryList> {
  List<WorkRow> _works = const [];
  int _total = 0;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(LibraryList old) {
    super.didUpdateWidget(old);
    if (old.view != widget.view) _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final works = await widget.library.works({...widget.view, 'limit': 200});
    final total = await widget.library.count(widget.view);
    if (!mounted) return;
    setState(() {
      _works = works;
      _total = total;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    if (_loading) return const Center(child: CircularProgressIndicator());
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
              _total == _works.length
                  ? '$_total works'
                  : 'showing ${_works.length} of $_total',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
          ),
        ),
        Expanded(
          child: ListView.separated(
            itemCount: _works.length,
            separatorBuilder: (_, __) =>
                Divider(height: 1, color: ground.lineSoft),
            itemBuilder: (context, i) => WorkRowTile(
              work: _works[i],
              onTap: () => widget.onOpen(_works[i]),
            ),
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
