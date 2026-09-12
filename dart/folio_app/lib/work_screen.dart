import 'package:flutter/material.dart';

import 'archive_acts.dart';
import 'downloads.dart';
import 'library.dart';
import 'theme.dart';
import 'work_actions.dart';

/// A work's own front page.
///
/// Opening a work used to drop straight into chapter one, which is fine for
/// carrying on and wrong for everything else: there was nowhere to read what
/// a work is before reading it, no way to reach chapter nine, and no way out
/// of a work except backwards.
///
/// Everything on it is live. The byline opens the person; a fandom, a
/// pairing, a character, a tag, the rating and the language each narrow the
/// library to everything that shares it. A work is a set of connections to
/// the rest of a library, and printing them as grey text throws that away.
class WorkScreen extends StatefulWidget {
  const WorkScreen({
    required this.library,
    required this.workId,
    required this.onRead,
    required this.onPerson,
    required this.onNarrow,
    this.downloads,
    super.key,
  });

  final Library library;
  final String workId;

  /// Open the reader at a chapter.
  final void Function(WorkRow work, List<ChapterRow> chapters, int chapter)
  onRead;

  final void Function(String byline) onPerson;
  final void Function(Map<String, Object?> view, String title) onNarrow;
  final Downloads? downloads;

  @override
  State<WorkScreen> createState() => _WorkScreenState();
}

class _WorkScreenState extends State<WorkScreen> {
  WorkRow? _work;
  List<ChapterRow> _chapters = const [];
  Map<String, List<String>> _tags = const {};
  Place? _place;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final work = await widget.library.work(widget.workId);
    final chapters = await widget.library.chapters(widget.workId);
    final tags = await widget.library.tagsFor(widget.workId);
    final place = await widget.library.placeIn(widget.workId);
    if (!mounted) return;
    setState(() {
      _work = work;
      _chapters = chapters;
      _tags = tags;
      _place = place;
      _loading = false;
    });
  }

  int get _resume {
    final at = _place?.chapter ?? 1;
    return at < 1 ? 1 : at;
  }

  bool get _started => (_place?.chapter ?? 1) > 1 || (_place?.offset ?? 0) > 0;

  void _read(int chapter) {
    final work = _work;
    if (work == null) return;
    widget.onRead(work, _chapters, chapter);
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final work = _work;

    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (work == null) {
      return Scaffold(
        appBar: AppBar(),
        body: const Center(child: Text('That work is not here any more.')),
      );
    }

    return Scaffold(
      appBar: AppBar(
        actions: [
          IconButton(
            icon: Icon(
              work.markedLater ? Icons.bookmark : Icons.bookmark_border,
            ),
            tooltip: work.markedLater ? 'Stop keeping it' : 'Keep for later',
            onPressed: () async {
              await widget.library.markLater(
                work.workId,
                later: !work.markedLater,
              );
              await _load();
            },
          ),
          if (widget.downloads?.canAct ?? false)
            IconButton(
              icon: const Icon(Icons.star_outline),
              tooltip: 'On the archive',
              onPressed: () => showArchiveActs(
                context,
                downloads: widget.downloads!,
                work: work,
              ),
            ),
          IconButton(
            icon: const Icon(Icons.more_vert),
            tooltip: 'More',
            onPressed: () async {
              final here = Navigator.of(context);
              final changed = await showWorkActions(
                context,
                library: widget.library,
                work: work,
                downloads: widget.downloads,
              );
              // deleting or blocking from here leaves nothing to come back to
              if (changed) here.pop(true);
            },
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 110),
        children: [
          Text(
            work.title,
            style: TextStyle(
              fontFamily: titleFace,
              fontSize: 25,
              fontWeight: FontWeight.w600,
              height: 1.25,
              color: ground.ink,
            ),
          ),
          const SizedBox(height: 8),

          // the byline, each name its own way in
          Wrap(
            spacing: 6,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text('by', style: TextStyle(color: ground.inkMute)),
              for (final name in work.authors)
                _Live(
                  text: name,
                  ground: ground,
                  strong: true,
                  onTap: () => widget.onPerson(name),
                ),
              if (work.authors.isEmpty)
                Text('Anonymous', style: TextStyle(color: ground.inkMid)),
            ],
          ),

          if (work.summary?.isNotEmpty ?? false) ...[
            const SizedBox(height: 16),
            Text(
              work.summary!,
              style: TextStyle(
                fontSize: 15,
                height: 1.55,
                color: ground.inkMid,
              ),
            ),
          ],

          const SizedBox(height: 18),
          _Facts(work: work, chapters: _chapters.length, ground: ground),

          const SizedBox(height: 16),
          ..._tagRows(ground, work),

          const SizedBox(height: 22),
          _Chapters(
            chapters: _chapters,
            at: _resume,
            ground: ground,
            onRead: _read,
          ),
        ],
      ),
      floatingActionButton: _chapters.isEmpty
          ? null
          : FloatingActionButton.extended(
              onPressed: () => _read(_resume),
              icon: Icon(_started ? Icons.play_arrow : Icons.menu_book),
              label: Text(
                _started
                    ? (_chapters.length > 1
                          ? 'Carry on, chapter $_resume'
                          : 'Carry on')
                    : 'Read',
              ),
            ),
    );
  }

  /// Land in the library, narrowed to one thing this work is.
  ///
  /// A fresh view rather than one more condition on the last one: "everything
  /// tagged this" means everything, and narrowing what was already on screen
  /// would answer a question nobody asked from a page that does not show what
  /// is already in force.
  void _narrowTo(String key, String value, {bool many = false}) =>
      widget.onNarrow({
        key: many ? [value] : value,
        'sort': 'added',
      }, value);

  /// Every tag, by kind, each one a way into the library.
  List<Widget> _tagRows(Ground ground, WorkRow work) {
    const named = {
      'fandom': 'Fandom',
      'relationship': 'Relationships',
      'character': 'Characters',
      'freeform': 'Tags',
      'warning': 'Warnings',
      'category': 'Category',
      'collection': 'Collections',
    };

    final rows = <Widget>[];

    void row(String label, List<Widget> chips) {
      if (chips.isEmpty) return;
      rows.addAll([
        Padding(
          padding: const EdgeInsets.only(top: 12, bottom: 6),
          child: Text(
            label.toUpperCase(),
            style: TextStyle(
              fontSize: 10.5,
              letterSpacing: 0.9,
              fontWeight: FontWeight.w600,
              color: ground.inkFaint,
            ),
          ),
        ),
        Wrap(spacing: 6, runSpacing: 6, children: chips),
      ]);
    }

    if (work.rating != null && work.rating!.isNotEmpty) {
      row('Rating', [
        _Live(
          text: work.rating!,
          ground: ground,
          onTap: () => _narrowTo('rating', work.rating!, many: true),
        ),
      ]);
    }

    for (final kind in named.keys) {
      final names = _tags[kind] ?? const [];
      row(named[kind]!, [
        for (final name in names)
          _Live(
            text: name,
            ground: ground,
            onTap: () => _narrowTo('include', name, many: true),
          ),
      ]);
    }

    if (work.language != null && work.language!.isNotEmpty) {
      row('Language', [
        _Live(
          text: work.language!,
          ground: ground,
          onTap: () => _narrow({'language': work.language}, work.language!),
        ),
      ]);
    }

    return rows;
  }
}

/// Something you can press, that looks like it.
///
/// A tag printed as grey text is a dead end; the same tag as a chip is the
/// question "what else is like this" already asked.
class _Live extends StatelessWidget {
  const _Live({
    required this.text,
    required this.ground,
    required this.onTap,
    this.strong = false,
  });

  final String text;
  final Ground ground;
  final VoidCallback onTap;
  final bool strong;

  @override
  Widget build(BuildContext context) => Material(
    color: strong ? ground.accent.withValues(alpha: 0.10) : ground.sunken,
    borderRadius: BorderRadius.circular(Radii.pill),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Radii.pill),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
        child: Text(
          text,
          style: TextStyle(
            fontSize: 13,
            fontWeight: strong ? FontWeight.w600 : FontWeight.w400,
            color: strong ? ground.accent : ground.inkMid,
          ),
        ),
      ),
    ),
  );
}

/// The numbers, said once and plainly.
class _Facts extends StatelessWidget {
  const _Facts({
    required this.work,
    required this.chapters,
    required this.ground,
  });

  final WorkRow work;
  final int chapters;
  final Ground ground;

  @override
  Widget build(BuildContext context) {
    final said = <String>[
      if (work.words != null) '${_thousands(work.words!)} words',
      if (chapters > 0)
        '$chapters ${chapters == 1 ? 'chapter' : 'chapters'}'
      else if (work.chapterCount != null)
        '${work.chapterCount} chapters',
      if (work.complete != null) work.complete! ? 'complete' : 'in progress',
      if (work.kudos != null) '${_thousands(work.kudos!)} kudos',
      if (work.hits != null) '${_thousands(work.hits!)} hits',
      if (!work.hasText) 'not downloaded',
    ];

    return Text(
      said.join(' · '),
      style: TextStyle(fontSize: 13, height: 1.5, color: ground.inkMute),
    );
  }
}

/// The chapters, so chapter nine is one tap rather than eight.
class _Chapters extends StatelessWidget {
  const _Chapters({
    required this.chapters,
    required this.at,
    required this.ground,
    required this.onRead,
  });

  final List<ChapterRow> chapters;
  final int at;
  final Ground ground;
  final void Function(int) onRead;

  @override
  Widget build(BuildContext context) {
    if (chapters.length < 2) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'CHAPTERS',
          style: TextStyle(
            fontSize: 10.5,
            letterSpacing: 0.9,
            fontWeight: FontWeight.w600,
            color: ground.inkFaint,
          ),
        ),
        const SizedBox(height: 4),
        for (final chapter in chapters)
          InkWell(
            onTap: () => onRead(chapter.number),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 11),
              child: Row(
                children: [
                  SizedBox(
                    width: 34,
                    child: Text(
                      '${chapter.number}',
                      style: TextStyle(
                        fontSize: 13,
                        color: chapter.number == at
                            ? ground.accent
                            : ground.inkFaint,
                        fontWeight: chapter.number == at
                            ? FontWeight.w700
                            : FontWeight.w400,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      chapter.title?.isNotEmpty ?? false
                          ? chapter.title!
                          : 'Chapter ${chapter.number}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14.5,
                        color: ground.ink,
                        fontWeight: chapter.number == at
                            ? FontWeight.w600
                            : FontWeight.w400,
                      ),
                    ),
                  ),
                  // where you got to, so the list is a place rather than an index
                  if (chapter.number == at)
                    Text(
                      'here',
                      style: TextStyle(fontSize: 11.5, color: ground.accent),
                    ),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

String _thousands(int n) {
  final digits = '$n';
  final out = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) out.write(',');
    out.write(digits[i]);
  }
  return out.toString();
}
