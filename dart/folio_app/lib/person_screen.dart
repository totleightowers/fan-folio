import 'package:flutter/material.dart';

import 'downloads.dart';
import 'library.dart';
import 'theme.dart';
import 'work_card.dart';

/// One person: what they wrote, and what they liked.
///
/// Two questions, and both are answered from the library rather than by
/// sending somebody to a screen that offers to go and look. A listing
/// describes twenty works for one request, so walking somebody's pages is
/// cheap and downloading them is not — which means the honest shape is a
/// shelf that is already populated, with a way to go and see what has
/// changed since.
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
  List<WorkRow> _wrote = const [];
  List<WorkRow> _liked = const [];
  bool _blocked = false;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  /// Everything of theirs the library holds, as the Library would ask it.
  Map<String, Object?> get _theirs => {
    'author': [widget.byline],
    'sort': 'added',
  };

  Future<void> _load() async {
    final wrote = await widget.library.works({..._theirs, 'limit': 500});
    final liked = await widget.library.bookmarkedBy(widget.byline);
    final blocked = (await widget.library.blockedNames()).contains(
      widget.byline,
    );
    if (!mounted) return;
    setState(() {
      _wrote = wrote;
      _liked = liked;
      _blocked = blocked;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);

    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(
            widget.byline,
            style: TextStyle(fontFamily: titleFace, color: ground.ink),
          ),
          actions: [
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
            tabs: [
              Tab(text: 'Works (${_wrote.length})'),
              Tab(text: 'Bookmarks (${_liked.length})'),
            ],
          ),
        ),
        body: _loading
            ? const Center(child: CircularProgressIndicator())
            : TabBarView(
                children: [
                  _Shelf(
                    works: _wrote,
                    byline: widget.byline,
                    bookmarks: false,
                    library: widget.library,
                    downloads: widget.downloads,
                    ground: ground,
                    onOpen: widget.onOpen,
                    onSynced: _load,
                    onSeeAll: () => widget.onNarrow(_theirs, widget.byline),
                  ),
                  _Shelf(
                    works: _liked,
                    byline: widget.byline,
                    bookmarks: true,
                    library: widget.library,
                    downloads: widget.downloads,
                    ground: ground,
                    onOpen: widget.onOpen,
                    onSynced: _load,
                  ),
                ],
              ),
      ),
    );
  }
}

/// One shelf, and the way to bring it up to date.
class _Shelf extends StatefulWidget {
  const _Shelf({
    required this.works,
    required this.byline,
    required this.bookmarks,
    required this.library,
    required this.downloads,
    required this.ground,
    required this.onOpen,
    required this.onSynced,
    this.onSeeAll,
  });

  final List<WorkRow> works;
  final String byline;
  final bool bookmarks;
  final Library library;
  final Downloads? downloads;
  final Ground ground;
  final void Function(WorkRow) onOpen;
  final Future<void> Function() onSynced;
  final VoidCallback? onSeeAll;

  @override
  State<_Shelf> createState() => _ShelfState();
}

class _ShelfState extends State<_Shelf> with AutomaticKeepAliveClientMixin {
  bool _walking = false;
  String? _where;
  String? _trouble;
  String? _lastWalk;

  @override
  bool get wantKeepAlive => true;

  String get _key =>
      '${widget.bookmarks ? 'bookmarks' : 'works'}:${widget.byline}';

  @override
  void initState() {
    super.initState();
    _readLastWalk();
  }

  Future<void> _readLastWalk() async {
    final at = await widget.library.lastWalk(_key);
    if (!mounted || at == null) return;
    setState(() => _lastWalk = _when(at));
  }

  /// Walk their pages and write down what they describe.
  ///
  /// The whole of them, not the first page: a person with sixty works has
  /// three pages, and stopping at one is the bug that made this screen lie
  /// about what it was showing.
  Future<void> _sync() async {
    final downloads = widget.downloads;
    if (downloads == null || _walking) return;
    setState(() {
      _walking = true;
      _trouble = null;
      _where = 'Reading page 1';
    });
    try {
      await downloads.syncPerson(
        widget.byline,
        bookmarks: widget.bookmarks,
        onProgress: (page, pages, found) {
          if (!mounted) return;
          setState(() {
            _where = pages == null
                ? 'Page $page · $found so far'
                : 'Page $page of $pages · $found so far';
          });
        },
      );
      await widget.onSynced();
      await _readLastWalk();
      if (!mounted) return;
      setState(() {
        _walking = false;
        _where = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _walking = false;
        _where = null;
        _trouble = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final ground = widget.ground;

    return Column(
      children: [
        _SyncBar(
          bookmarks: widget.bookmarks,
          byline: widget.byline,
          ground: ground,
          walking: _walking,
          where: _where,
          trouble: _trouble,
          lastWalk: _lastWalk,
          onSync: widget.downloads == null ? null : _sync,
        ),
        Expanded(
          child: widget.works.isEmpty
              ? _Nothing(bookmarks: widget.bookmarks, ground: ground)
              : ListView.separated(
                  itemCount:
                      widget.works.length + (widget.onSeeAll == null ? 0 : 1),
                  separatorBuilder: (_, __) =>
                      Divider(height: 1, color: ground.lineSoft),
                  itemBuilder: (context, i) {
                    if (i == widget.works.length) {
                      return Padding(
                        padding: const EdgeInsets.all(16),
                        child: OutlinedButton(
                          onPressed: widget.onSeeAll,
                          child: const Text('See these in the library'),
                        ),
                      );
                    }
                    return WorkRowTile(
                      work: widget.works[i],
                      onTap: () => widget.onOpen(widget.works[i]),
                    );
                  },
                ),
        ),
      ],
    );
  }
}

/// The sync, where it can be seen without hunting for it.
class _SyncBar extends StatelessWidget {
  const _SyncBar({
    required this.bookmarks,
    required this.byline,
    required this.ground,
    required this.walking,
    required this.where,
    required this.trouble,
    required this.lastWalk,
    required this.onSync,
  });

  final bool bookmarks;
  final String byline;
  final Ground ground;
  final bool walking;
  final String? where;
  final String? trouble;
  final String? lastWalk;
  final VoidCallback? onSync;

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    margin: const EdgeInsets.fromLTRB(12, 12, 12, 4),
    padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
    decoration: BoxDecoration(
      color: ground.surface,
      borderRadius: BorderRadius.circular(Radii.card),
      border: Border.all(color: ground.lineSoft),
    ),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                bookmarks
                    ? 'What $byline has bookmarked'
                    : 'Everything $byline has written',
                style: TextStyle(
                  fontFamily: titleFace,
                  fontSize: 14.5,
                  fontWeight: FontWeight.w600,
                  color: ground.ink,
                ),
              ),
              const SizedBox(height: 3),
              Text(
                where ??
                    trouble ??
                    (lastWalk == null
                        ? 'Read their pages and list what is there. Nothing '
                              'is downloaded by it.'
                        : 'Last read $lastWalk'),
                style: TextStyle(
                  fontSize: 12.5,
                  height: 1.35,
                  color: trouble == null ? ground.inkMute : ground.accent,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        if (walking)
          const SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        else
          FilledButton.tonal(
            onPressed: onSync,
            child: Text(lastWalk == null ? 'Sync' : 'Sync again'),
          ),
      ],
    ),
  );
}

class _Nothing extends StatelessWidget {
  const _Nothing({required this.bookmarks, required this.ground});

  final bool bookmarks;
  final Ground ground;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(32),
      child: Text(
        bookmarks
            ? 'Nothing of theirs is listed here yet. Sync to read their '
                  'bookmarks — if they are public.'
            : 'Nothing of theirs is here yet. Sync to list their works.',
        textAlign: TextAlign.center,
        style: TextStyle(color: ground.inkMute, height: 1.5),
      ),
    ),
  );
}

/// Roughly when, which is all anybody wants from a last-run time.
String _when(DateTime at) {
  final ago = DateTime.now().difference(at);
  if (ago.inMinutes < 2) return 'just now';
  if (ago.inHours < 1) return '${ago.inMinutes} minutes ago';
  if (ago.inHours < 24) {
    return '${ago.inHours} ${ago.inHours == 1 ? 'hour' : 'hours'} ago';
  }
  if (ago.inDays < 30) {
    return '${ago.inDays} ${ago.inDays == 1 ? 'day' : 'days'} ago';
  }
  return 'on ${at.toIso8601String().substring(0, 10)}';
}
