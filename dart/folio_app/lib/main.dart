import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart';

import 'library.dart';
import 'reader.dart';
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

  Future<void> _load() async {
    try {
      final library = await Library.openExisting();
      if (library == null) {
        setState(() {
          _loading = false;
          _trouble = 'No library here yet.';
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
                      FilledButton(
                        onPressed: () => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ReaderScreen(
                              library: library,
                              work: work,
                              chapter: 1,
                            ),
                          ),
                        ),
                        child: const Text('Read'),
                      )
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

/// A chapter, read.
class ReaderScreen extends StatelessWidget {
  const ReaderScreen({
    required this.library,
    required this.work,
    required this.chapter,
    super.key,
  });

  final Library library;
  final WorkRow work;
  final int chapter;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('Chapter $chapter')),
        body: FutureBuilder<String?>(
          future: library.chapterHtml(work.workId, chapter),
          builder: (context, snapshot) {
            if (!snapshot.hasData) {
              return const Center(child: CircularProgressIndicator());
            }
            /* Native text unless the author wrote a skin, in which case the
               skin is the work and it is read the way they wrote it. */
            if (needsWebView(skinCss: work.skinCss)) {
              return const _SkinNotice();
            }
            return ChapterView(
              document: parseChapter(snapshot.data),
              settings: const ReadingSettings(),
            );
          },
        ),
      );
}

/// Until the WebView half is wired, a skinned work says so rather than being
/// quietly rendered in a way its author did not write.
class _SkinNotice extends StatelessWidget {
  const _SkinNotice();

  @override
  Widget build(BuildContext context) => const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Text(
            'This work carries the author’s own styling, so it is read in the '
            'archive’s layout rather than as plain text. That reader is not '
            'wired up in this build yet.',
            textAlign: TextAlign.center,
          ),
        ),
      );
}
