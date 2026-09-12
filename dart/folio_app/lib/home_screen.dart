import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'library.dart';
import 'theme.dart';
import 'work_card.dart';

/// What somebody came back for, first.
///
/// A thousand works sorted alphabetically is a filing cabinet. What a reader
/// wants on opening is the thing they were in the middle of, then a few ways
/// in — and then, so the screen reads as *their* archive rather than a generic
/// discovery page, what the library amounts to.
class HomeScreen extends StatefulWidget {
  const HomeScreen({
    required this.library,
    required this.onOpen,
    required this.onSeeAll,
    required this.onNarrow,
    required this.onOpenById,
    this.onHold,
    super.key,
  });

  final Library library;
  final void Function(WorkRow) onOpen;
  final void Function(Map<String, Object?> view, String title) onSeeAll;

  /// A chip or a tile is a filter, not a category page: choosing one lands in
  /// the library already narrowed, which is one screen rather than two.
  final void Function(Map<String, Object?> view, String title) onNarrow;

  /// Surprise me has a work id rather than a row to open with.
  final void Function(String workId) onOpenById;

  final void Function(WorkRow)? onHold;

  @override
  State<HomeScreen> createState() => HomeScreenState();
}

class HomeScreenState extends State<HomeScreen> {
  final List<(core.Shelf, List<WorkRow>, int)> _shelves = [];
  Stats? _stats;
  Map<String, List<Count>> _browse = const {};
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    reload();
  }

  /// Arriving at Home rebuilds it. Screens are kept rather than torn down,
  /// which is what makes going back instant — and what would otherwise leave
  /// Home showing the shelves from before somebody read something.
  Future<void> reload() async {
    final built = <(core.Shelf, List<WorkRow>, int)>[];
    for (final shelf in core.shelves()) {
      final (works, total) = await widget.library.shelf(shelf);
      if (works.isNotEmpty) built.add((shelf, works, total));
    }
    final stats = await widget.library.stats();
    final browse = await widget.library.browse();
    if (!mounted) return;
    setState(() {
      _shelves
        ..clear()
        ..addAll(built);
      _stats = stats;
      _browse = browse;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_shelves.isEmpty) {
      return Center(
        child: Text(
          'Nothing here yet.',
          style: TextStyle(color: groundOf(context).inkMute),
        ),
      );
    }

    /* Assembled as a list of sections rather than counted out of an index.
       The stats used to be placed by arithmetic on the item number, which is
       fine until something else goes on the screen — and then the ways in
       land between two shelves. */
    final sections = <Widget>[
      for (var i = 0; i < _shelves.length; i++) ...[
        Builder(
          builder: (context) {
            final (shelf, works, total) = _shelves[i];
            return Shelf(
              title: shelf.title,
              works: works,
              total: total,
              onOpen: widget.onOpen,
              onHold: widget.onHold,
              onSeeAll: () => widget.onSeeAll(shelf.view, shelf.title),
            );
          },
        ),
        /* The counts go directly under the thing somebody came back for. Left
           at the foot they sat under every shelf and the whole of Browse,
           which is present and out of sight. */
        if (i == 0 && _stats != null) _StatsRow(stats: _stats!),
      ],
      _StartHere(
        library: widget.library,
        onNarrow: widget.onNarrow,
        onOpenById: widget.onOpenById,
      ),
      if (_browse.isNotEmpty)
        _Browse(browse: _browse, onNarrow: widget.onNarrow),
    ];

    return ListView.builder(
      padding: const EdgeInsets.only(bottom: 24),
      itemCount: sections.length,
      itemBuilder: (context, i) => sections[i],
    );
  }
}

/// The two questions the library could already answer and had no door to.
///
/// Held as constants rather than written at the call: the formatter splits a
/// map literal passed inline, and a split argument list wants a trailing comma
/// the formatter then takes away again.
const Map<String, Object?> _forLater = {'state': 'later', 'sort': 'title'};
const Map<String, Object?> _neverOpened = {'state': 'unread', 'sort': 'added'};

/// Three ways to start, for the times when what you want is not a work but a
/// way of choosing one.
class _StartHere extends StatelessWidget {
  const _StartHere({
    required this.library,
    required this.onNarrow,
    required this.onOpenById,
  });

  final Library library;
  final void Function(Map<String, Object?> view, String title) onNarrow;
  final void Function(String workId) onOpenById;

  Future<void> _surprise(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final workId = await library.surprise();
    if (workId == null) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Nothing unread left.')),
      );
      return;
    }
    onOpenById(workId);
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 20, 16, 4),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionTitle('Start here'),
        const SizedBox(height: 10),
        Row(
          children: [
            Expanded(
              child: _Tile(
                title: 'Surprise me',
                note: 'something you have never opened',
                onTap: () => _surprise(context),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _Tile(
                title: 'For later',
                note: 'what you meant to get to',
                onTap: () => onNarrow(_forLater, 'Marked for later'),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _Tile(
                title: 'Never opened',
                note: 'the ones still waiting',
                onTap: () => onNarrow(_neverOpened, 'Never opened'),
              ),
            ),
          ],
        ),
      ],
    ),
  );
}

class _Tile extends StatelessWidget {
  const _Tile({required this.title, required this.note, required this.onTap});

  final String title;
  final String note;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    return Material(
      color: ground.surface,
      borderRadius: BorderRadius.circular(Radii.card),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Radii.card),
        child: Ink(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Radii.card),
            border: Border.all(color: ground.lineSoft),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 10, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontFamily: titleFace,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w600,
                    color: ground.ink,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  note,
                  style: TextStyle(
                    fontSize: 11.5,
                    height: 1.3,
                    color: ground.inkMute,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Ways in that are not a list.
///
/// Fic is found by fandom and pairing far more often than by title, so those
/// are the front door. Each chip is a filter rather than a category page:
/// tapping one lands in the library already narrowed.
class _Browse extends StatefulWidget {
  const _Browse({required this.browse, required this.onNarrow});

  final Map<String, List<Count>> browse;
  final void Function(Map<String, Object?> view, String title) onNarrow;

  @override
  State<_Browse> createState() => _BrowseState();
}

class _BrowseState extends State<_Browse> {
  late String _kind = widget.browse.keys.first;

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final kinds = [
      for (final (kind, title, _) in core.browseKinds)
        if (widget.browse[kind]?.isNotEmpty ?? false) (kind, title),
    ];
    final counts = widget.browse[_kind] ?? const <Count>[];

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 22, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionTitle('Browse'),
          const SizedBox(height: 8),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final (kind, title) in kinds)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(title),
                      showCheckmark: false,
                      selected: kind == _kind,
                      onSelected: (_) => setState(() => _kind = kind),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final count in counts)
                _BrowseChip(
                  count: count,
                  /* A card's spine is a hash of its fandom, so the same name
                     is the same colour wherever it appears. Tinting the chip
                     with it makes this row a key to the shelves above. A
                     pairing or a rating has no spine of its own to agree
                     with, so it gets none. */
                  spine: _kind == 'fandom'
                      ? Color(0xFF000000 | core.spineRgb(count.name))
                      : null,
                  ground: ground,
                  onTap: () => widget.onNarrow(
                    _kind == 'rating'
                        ? {
                            'rating': [count.name],
                            'sort': 'added',
                          }
                        : {
                            'include': [count.name],
                            'sort': 'added',
                          },
                    count.name,
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _BrowseChip extends StatelessWidget {
  const _BrowseChip({
    required this.count,
    required this.spine,
    required this.ground,
    required this.onTap,
  });

  final Count count;
  final Color? spine;
  final Ground ground;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
    color: ground.surface,
    borderRadius: BorderRadius.circular(Radii.pill),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Radii.pill),
      child: Ink(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(Radii.pill),
          border: Border.all(color: ground.lineSoft),
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(11, 7, 11, 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (spine != null) ...[
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: spine,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 7),
              ],
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 200),
                child: Text(
                  count.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13.5, color: ground.ink),
                ),
              ),
              const SizedBox(width: 7),
              Text(
                '${count.n}',
                style: TextStyle(fontSize: 12, color: ground.inkFaint),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// A sign, not a headline competing with the titles under it.
class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: TextStyle(
      fontFamily: titleFace,
      fontSize: 16,
      fontWeight: FontWeight.w600,
      color: groundOf(context).ink,
    ),
  );
}

class _StatsRow extends StatelessWidget {
  const _StatsRow({required this.stats});

  final Stats stats;

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    String big(int n) =>
        n >= 1000000 ? '${(n / 1000000).toStringAsFixed(1)}M' : _thousands(n);

    final cells = <(String, String)>[
      (_thousands(stats.works), 'works'),
      (big(stats.words), 'words'),
      (_thousands(stats.finished), 'finished'),
      (big(stats.wordsRead), 'words read'),
      if (stats.later > 0) (_thousands(stats.later), 'for later'),
    ];

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 20, 16, 4),
      child: Wrap(
        spacing: 10,
        runSpacing: 10,
        children: [
          for (final (value, label) in cells)
            Container(
              width: 104,
              padding: const EdgeInsets.symmetric(vertical: 11, horizontal: 12),
              decoration: BoxDecoration(
                color: ground.surface,
                borderRadius: BorderRadius.circular(Radii.card),
                border: Border.all(color: ground.lineSoft),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    value,
                    style: TextStyle(
                      fontFamily: titleFace,
                      fontSize: 19,
                      fontWeight: FontWeight.w600,
                      color: ground.ink,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                  Text(
                    label,
                    style: TextStyle(fontSize: 11.5, color: ground.inkMute),
                  ),
                ],
              ),
            ),
        ],
      ),
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
