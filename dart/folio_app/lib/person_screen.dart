import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'downloads.dart';
import 'library.dart';
import 'theme.dart';
import 'work_card.dart';

/// One person: what of theirs you have, what they have, and what they liked.
///
/// A byline was dead text, which made an author a fact about a work rather
/// than a way through a library. Three questions get asked of a name — what
/// of theirs have I got, what else have they written, what do they read — and
/// they are three tabs rather than three screens because they are the same
/// question about the same person.
class PersonScreen extends StatefulWidget {
  const PersonScreen({
    required this.library,
    required this.byline,
    required this.onOpen,
    required this.onNarrow,
    this.downloads,
    super.key,
  });

  final Library library;
  final String byline;
  final void Function(WorkRow) onOpen;
  final void Function(Map<String, Object?> view, String title) onNarrow;
  final Downloads? downloads;

  @override
  State<PersonScreen> createState() => _PersonScreenState();
}

class _PersonScreenState extends State<PersonScreen> {
  List<WorkRow> _held = const [];
  bool _blocked = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final held = await widget.library.works({..._theirs, 'limit': 200});
    final blocked = (await widget.library.blockedNames()).contains(
      widget.byline,
    );
    if (!mounted) return;
    setState(() {
      _held = held;
      _blocked = blocked;
      _loading = false;
    });
  }

  /// Everything of theirs the library holds, as the Library would ask it.
  Map<String, Object?> get _theirs => {
    'author': [widget.byline],
    'sort': 'added',
  };

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final online = widget.downloads;

    return DefaultTabController(
      // their works and their bookmarks are only askable with a session, and
      // an empty tab that cannot say why is worse than no tab
      length: online == null ? 1 : 3,
      child: Scaffold(
        appBar: AppBar(
          title: Text(
            widget.byline,
            style: TextStyle(fontFamily: titleFace, color: ground.ink),
          ),
          actions: [
            if (online != null)
              PopupMenuButton<String>(
                itemBuilder: (context) => [
                  PopupMenuItem(
                    value: 'block',
                    child: Text(_blocked ? 'Unblock' : 'Block'),
                  ),
                ],
                onSelected: (_) async {
                  await widget.library.setBlocked(
                    widget.byline,
                    blocked: !_blocked,
                  );
                  await _load();
                },
              ),
          ],
          bottom: TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: [
              Tab(text: 'In your library (${_held.length})'),
              if (online != null) const Tab(text: 'Everything they wrote'),
              if (online != null) const Tab(text: 'What they liked'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _Held(
              works: _held,
              loading: _loading,
              ground: ground,
              byline: widget.byline,
              onOpen: widget.onOpen,
              onSeeAll: () => widget.onNarrow(_theirs, widget.byline),
            ),
            if (online != null)
              _FromTheArchive(
                key: const ValueKey('works'),
                downloads: online,
                library: widget.library,
                byline: widget.byline,
                bookmarks: false,
                onOpen: widget.onOpen,
              ),
            if (online != null)
              _FromTheArchive(
                key: const ValueKey('bookmarks'),
                downloads: online,
                library: widget.library,
                byline: widget.byline,
                bookmarks: true,
                onOpen: widget.onOpen,
              ),
          ],
        ),
      ),
    );
  }
}

class _Held extends StatelessWidget {
  const _Held({
    required this.works,
    required this.loading,
    required this.ground,
    required this.byline,
    required this.onOpen,
    required this.onSeeAll,
  });

  final List<WorkRow> works;
  final bool loading;
  final Ground ground;
  final String byline;
  final void Function(WorkRow) onOpen;
  final VoidCallback onSeeAll;

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (works.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Text(
            'Nothing of theirs is here yet.',
            textAlign: TextAlign.center,
            style: TextStyle(color: ground.inkMute, height: 1.5),
          ),
        ),
      );
    }

    return ListView.separated(
      itemCount: works.length + 1,
      separatorBuilder: (_, __) => Divider(height: 1, color: ground.lineSoft),
      itemBuilder: (context, i) {
        if (i == works.length) {
          return Padding(
            padding: const EdgeInsets.all(16),
            child: OutlinedButton(
              onPressed: onSeeAll,
              child: const Text('See these in the library'),
            ),
          );
        }
        return WorkRowTile(work: works[i], onTap: () => onOpen(works[i]));
      },
    );
  }
}

/// What their pages say, which is not the same as what you hold.
///
/// Asked only when the tab is opened: a person's page is a request, and
/// loading two of them because somebody tapped a byline is two requests
/// nobody asked for.
class _FromTheArchive extends StatefulWidget {
  const _FromTheArchive({
    required this.downloads,
    required this.library,
    required this.byline,
    required this.bookmarks,
    required this.onOpen,
    super.key,
  });

  final Downloads downloads;
  final Library library;
  final String byline;
  final bool bookmarks;
  final void Function(WorkRow) onOpen;

  @override
  State<_FromTheArchive> createState() => _FromTheArchiveState();
}

class _FromTheArchiveState extends State<_FromTheArchive>
    with AutomaticKeepAliveClientMixin {
  List<core.Blurb>? _listed;
  Set<String> _held = const {};
  final Set<String> _queued = {};
  bool _asking = false;
  String? _trouble;

  @override
  bool get wantKeepAlive => true;

  Future<void> _ask() async {
    setState(() {
      _asking = true;
      _trouble = null;
    });
    try {
      final listed = await widget.downloads.peek(
        widget.byline,
        bookmarks: widget.bookmarks,
      );
      final held = await widget.library
          .works({'limit': 1})
          .then((_) async => _heldAmong(listed));
      if (!mounted) return;
      setState(() {
        _listed = listed;
        _held = held;
        _asking = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _asking = false;
        _trouble = '$e';
      });
    }
  }

  Future<Set<String>> _heldAmong(List<core.Blurb> listed) async {
    final ids = [for (final blurb in listed) blurb.workId];
    if (ids.isEmpty) return const {};
    final marks = List.filled(ids.length, '?').join(',');
    final rows = await widget.library.db.rawQuery(
      'SELECT work_id FROM works '
      'WHERE work_id IN ($marks) AND COALESCE(has_text, 0) = 1',
      ids,
    );
    return {for (final row in rows) '${row['work_id']}'};
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final ground = groundOf(context);

    if (_asking) return const Center(child: CircularProgressIndicator());

    if (_listed == null) {
      /* Not fetched on arrival. Tapping a byline should cost nothing; asking
         the archive is a deliberate thing, at a reader's pace. */
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                widget.bookmarks
                    ? 'What this person has bookmarked, from their page on '
                          'the archive.'
                    : 'Everything on their works page, whether or not it is '
                          'here.',
                textAlign: TextAlign.center,
                style: TextStyle(color: ground.inkMute, height: 1.5),
              ),
              if (_trouble != null) ...[
                const SizedBox(height: 12),
                Text(
                  _trouble!,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: ground.accent, fontSize: 13),
                ),
              ],
              const SizedBox(height: 18),
              FilledButton(onPressed: _ask, child: const Text('Have a look')),
            ],
          ),
        ),
      );
    }

    final listed = _listed!;
    if (listed.isEmpty) {
      return Center(
        child: Text(
          widget.bookmarks
              ? 'Their bookmarks are not public.'
              : 'Their works page lists nothing.',
          style: TextStyle(color: ground.inkMute),
        ),
      );
    }

    return ListView.separated(
      itemCount: listed.length,
      separatorBuilder: (_, __) => Divider(height: 1, color: ground.lineSoft),
      itemBuilder: (context, i) {
        final blurb = listed[i];
        final have = _held.contains(blurb.workId);
        final queued = _queued.contains(blurb.workId);

        return ListTile(
          title: Text(
            blurb.title ?? '(untitled)',
            style: TextStyle(
              fontFamily: titleFace,
              fontWeight: FontWeight.w600,
              color: ground.ink,
            ),
          ),
          subtitle: Text(
            [
              blurb.authors.join(', '),
              if (blurb.words != null) '${blurb.words} words',
              if (blurb.fandoms.isNotEmpty) blurb.fandoms.first,
            ].where((s) => s.isNotEmpty).join(' · '),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12.5, color: ground.inkMute),
          ),
          trailing: have
              ? Icon(Icons.check, color: ground.inkFaint, size: 20)
              : IconButton(
                  icon: Icon(queued ? Icons.schedule : Icons.download_outlined),
                  tooltip: queued ? 'Queued' : 'Fetch it',
                  onPressed: queued
                      ? null
                      : () async {
                          setState(() => _queued.add(blurb.workId));
                          await widget.downloads.addWorks(widget.byline, [
                            blurb.workId,
                          ]);
                        },
                ),
          onTap: have
              ? () async {
                  final work = await widget.library.work(blurb.workId);
                  if (work != null) widget.onOpen(work);
                }
              : null,
        );
      },
    );
  }
}
