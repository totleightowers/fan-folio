import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart';

import 'library.dart';
import 'reader_screen.dart';
import 'search_screen.dart';
import 'theme.dart';

void main() => runApp(const FolioApp());

class FolioApp extends StatelessWidget {
  const FolioApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Fan Folio',
        debugShowCheckedModeBanner: false,
        theme: themeFor(Ground.light, Brightness.light),
        darkTheme: themeFor(Ground.dark, Brightness.dark),
        home: const LibraryScreen(),
      );
}

/// Everything held, newest first.
class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key});

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  Library? _library;
  List<WorkRow> _works = const [];
  int _total = 0;
  String? _trouble;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  /// Straight to a work, from wherever it was named.
  Future<void> _openWork(BuildContext context, String workId, {int chapter = 1}) async {
    final library = _library;
    if (library == null) return;
    final work = await library.work(workId);
    if (work == null || !context.mounted) return;
    final chapters = await library.chapters(workId);
    if (!context.mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ReaderScreen(
          library: library,
          work: work,
          chapters: chapters,
          startAt: chapter,
        ),
      ),
    );
  }

  /// A library just brought in becomes the one on screen.
  Future<void> _adopt(Library library) async {
    final works = await library.works({'sort': 'added', 'limit': 200});
    final total = await library.count();
    if (!mounted) return;
    setState(() {
      _library = library;
      _works = works;
      _total = total;
      _loading = false;
    });
  }

  Future<void> _load() async {
    try {
      final library = await Library.openExisting();
      if (library == null) {
        setState(() {
          _loading = false;
          _library = null;
        });
        return;
      }
      final works = await library.works({'sort': 'added', 'limit': 200});
      final total = await library.count();
      if (!mounted) return;
      setState(() {
        _library = library;
        _works = works;
        _total = total;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        // say what actually went wrong; a blank screen teaches nobody anything
        _trouble = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final ground = Theme.of(context).brightness == Brightness.dark
        ? Ground.dark
        : Ground.light;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Library'),
        actions: [
          if (_library != null)
            IconButton(
              icon: const Icon(Icons.search),
              tooltip: 'Search',
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => SearchScreen(
                    library: _library!,
                    onOpen: (workId, {int chapter = 1}) =>
                        _openWork(context, workId, chapter: chapter),
                  ),
                ),
              ),
            ),
        ],
        bottom: _total == 0
            ? null
            : PreferredSize(
                preferredSize: const Size.fromHeight(22),
                child: Padding(
                  padding: const EdgeInsets.only(left: 16, bottom: 8),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      '$_total works',
                      style: TextStyle(fontSize: 12.5, color: ground.inkMute),
                    ),
                  ),
                ),
              ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _trouble != null
              ? _Empty(message: _trouble!, ground: ground)
              : _library == null
              ? _NoLibrary(ground: ground, onImported: _adopt)
              : ListView.separated(
                  itemCount: _works.length,
                  separatorBuilder: (_, __) => Divider(
                    height: 1,
                    color: ground.lineSoft,
                  ),
                  itemBuilder: (context, i) => _WorkTile(
                    work: _works[i],
                    ground: ground,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => WorkScreen(
                          library: _library!,
                          workId: _works[i].workId,
                        ),
                      ),
                    ),
                  ),
                ),
    );
  }
}

/// Nothing here yet, and the way to change that.
///
/// This build keeps its own library, separate from the 1.x app's, because
/// Android gives every application its own private storage and one cannot
/// read another's. So a library arrives the way it leaves: as a backup file,
/// handed over.
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
      final picked = await FilePicker.platform.pickFiles(
        // deliberately not filtered by extension: a backup arrives named all
        // sorts of things, and a picker that hides the file somebody is
        // looking straight at is worse than one that shows too much
        withData: false,
      );
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
      // say what actually went wrong; a blank screen teaches nobody anything
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
                'This build keeps its own library, separate from the one your '
                '1.x app has, so nothing you rely on is touched. Back up from '
                'there and bring the file in here.',
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

class _Empty extends StatelessWidget {
  const _Empty({required this.message, required this.ground});

  final String message;
  final Ground ground;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text(
            message,
            textAlign: TextAlign.center,
            style: TextStyle(color: ground.inkMute, height: 1.5),
          ),
        ),
      );
}

class _WorkTile extends StatelessWidget {
  const _WorkTile({required this.work, required this.ground, required this.onTap});

  final WorkRow work;
  final Ground ground;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // The title leads. Everything under it is support, and is
              // weighted to say so.
              Text(
                work.title,
                style: TextStyle(
                  fontFamily: titleFace,
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  height: 1.3,
                  color: ground.ink,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                work.byline,
                style: TextStyle(fontSize: 13.5, color: ground.inkMute),
              ),
              if (work.summary != null && work.summary!.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  work.summary!,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14, height: 1.45, color: ground.inkMid),
                ),
              ],
              const SizedBox(height: 6),
              Text(
                [
                  if (work.fandom != null) work.fandom!,
                  if (work.words != null) '${work.words} words',
                  if (!work.hasText) 'not downloaded',
                ].join(' · '),
                style: TextStyle(fontSize: 12, color: ground.inkFaint),
              ),
            ],
          ),
        ),
      );
}

/// One work: what it is, and the way in.
class WorkScreen extends StatelessWidget {
  const WorkScreen({required this.library, required this.workId, super.key});

  final Library library;
  final String workId;

  @override
  Widget build(BuildContext context) {
    final ground = Theme.of(context).brightness == Brightness.dark
        ? Ground.dark
        : Ground.light;

    return FutureBuilder<WorkRow?>(
      future: library.work(workId),
      builder: (context, snapshot) {
        final work = snapshot.data;
        return Scaffold(
          appBar: AppBar(title: Text(work?.title ?? '')),
          body: work == null
              ? const Center(child: CircularProgressIndicator())
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Text(
                      work.title,
                      style: TextStyle(
                        fontFamily: titleFace,
                        fontSize: 24,
                        fontWeight: FontWeight.w600,
                        height: 1.25,
                        color: ground.ink,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(work.byline, style: TextStyle(color: ground.inkMute)),
                    const SizedBox(height: 16),
                    if (work.hasText)
                      _ReadButton(library: library, work: work)
                    else
                      Text(
                        'Not downloaded yet.',
                        style: TextStyle(color: ground.inkMute),
                      ),
                    if (work.summary != null && work.summary!.isNotEmpty) ...[
                      const SizedBox(height: 20),
                      Text(
                        work.summary!,
                        style: TextStyle(height: 1.5, color: ground.inkMid),
                      ),
                    ],
                  ],
                ),
        );
      },
    );
  }
}

/// The way in, which is also the way back to where you were.
///
/// A work opened from a shelf opens where it was left off, chapter and all.
/// Losing your place in a hundred thousand words is the difference between an
/// app somebody keeps and one they abandon.
class _ReadButton extends StatelessWidget {
  const _ReadButton({required this.library, required this.work});

  final Library library;
  final WorkRow work;

  Future<void> _open(BuildContext context) async {
    final chapters = await library.chapters(work.workId);
    final place = await library.placeIn(work.workId);
    final at = place?.chapter ?? 1;
    if (!context.mounted) return;
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
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<Place?>(
        future: library.placeIn(work.workId),
        builder: (context, snapshot) {
          final at = snapshot.data?.chapter;
          return FilledButton(
            onPressed: () => _open(context),
            child: Text(at != null && at > 1 ? 'Continue chapter $at' : 'Read'),
          );
        },
      );
}
