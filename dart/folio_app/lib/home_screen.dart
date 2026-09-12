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
    this.onHold,
    super.key,
  });

  final Library library;
  final void Function(WorkRow) onOpen;
  final void Function(Map<String, Object?> view, String title) onSeeAll;
  final void Function(WorkRow)? onHold;

  @override
  State<HomeScreen> createState() => HomeScreenState();
}

class HomeScreenState extends State<HomeScreen> {
  final List<(core.Shelf, List<WorkRow>, int)> _shelves = [];
  Stats? _stats;
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
    if (!mounted) return;
    setState(() {
      _shelves
        ..clear()
        ..addAll(built);
      _stats = stats;
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

    return ListView.builder(
      padding: const EdgeInsets.only(bottom: 24),
      // the counts go after the first shelf: last in the document they sit
      // under every shelf, which is present and out of sight
      itemCount: _shelves.length + 1,
      itemBuilder: (context, i) {
        if (i == 1 && _stats != null) return _StatsRow(stats: _stats!);
        final at = i > 1 ? i - 1 : i;
        final (shelf, works, total) = _shelves[at];
        return Shelf(
          title: shelf.title,
          works: works,
          total: total,
          onOpen: widget.onOpen,
          onHold: widget.onHold,
          onSeeAll: () => widget.onSeeAll(shelf.view, shelf.title),
        );
      },
    );
  }
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
