import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'library.dart';
import 'theme.dart';

/// What to narrow by, and what narrowing would leave.
///
/// Every count is against the filters already in force, which is the whole
/// point: the panel shows what choosing one more thing would actually leave,
/// so nobody picks a combination that yields nothing and then wonders whether
/// the library is broken.
class FilterSheet extends StatefulWidget {
  const FilterSheet({required this.library, required this.view, super.key});

  final Library library;
  final Map<String, Object?> view;

  @override
  State<FilterSheet> createState() => _FilterSheetState();
}

class _FilterSheetState extends State<FilterSheet> {
  late Map<String, Object?> _view = Map<String, Object?>.from(widget.view);
  int _matching = 0;
  bool _counting = true;

  /// Which sections are open. A panel that opens with everything expanded is
  /// a wall; one that opens with everything closed is a list of words.
  final Set<String> _open = {'fandom'};

  @override
  void initState() {
    super.initState();
    _recount();
  }

  Future<void> _recount() async {
    setState(() => _counting = true);
    final n = await widget.library.count(_view);
    if (!mounted) return;
    setState(() {
      _matching = n;
      _counting = false;
    });
  }

  List<String> _chosen(String key) =>
      (_view[key] as List?)?.cast<String>() ?? const [];

  void _toggle(String key, String value) {
    final now = [..._chosen(key)];
    now.contains(value) ? now.remove(value) : now.add(value);
    setState(() => _view[key] = now);
    _recount();
  }

  void _clear() {
    setState(() => _view = {'sort': _view['sort'] ?? 'added'});
    _recount();
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.85,
      builder: (context, scroll) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 8, 6),
            child: Row(
              children: [
                Text(
                  'Filters',
                  style: TextStyle(
                    fontFamily: titleFace,
                    fontSize: 19,
                    fontWeight: FontWeight.w600,
                    color: ground.ink,
                  ),
                ),
                const Spacer(),
                TextButton(onPressed: _clear, child: const Text('Clear')),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              controller: scroll,
              padding: const EdgeInsets.only(bottom: 12),
              children: [
                _StateSection(
                  chosen: '${_view['state'] ?? 'all'}',
                  onChosen: (state) {
                    setState(() => _view['state'] = state);
                    _recount();
                  },
                ),
                for (final kind in const [
                  'fandom',
                  'relationship',
                  'character',
                  'freeform',
                ])
                  _Facet(
                    key: ValueKey(kind),
                    title: _titles[kind]!,
                    open: _open.contains(kind),
                    onOpen: (yes) => setState(
                      () => yes ? _open.add(kind) : _open.remove(kind),
                    ),
                    chosen: _chosen('include'),
                    load: (needle) => widget.library.facet(
                      core.tagFacet(_view, kind, needle: needle),
                    ),
                    onTap: (name) => _toggle('include', name),
                  ),
                _Facet(
                  title: 'Rating',
                  open: _open.contains('rating'),
                  onOpen: (yes) => setState(
                    () => yes ? _open.add('rating') : _open.remove('rating'),
                  ),
                  chosen: _chosen('rating'),
                  searchable: false,
                  load: (_) =>
                      widget.library.facet(core.columnFacet(_view, 'rating')),
                  onTap: (name) => _toggle('rating', name),
                ),
                _Facet(
                  title: 'Authors',
                  open: _open.contains('author'),
                  onOpen: (yes) => setState(
                    () => yes ? _open.add('author') : _open.remove('author'),
                  ),
                  chosen: _chosen('author'),
                  load: (needle) => widget.library.facet(
                    core.authorFacet(_view, needle: needle),
                  ),
                  onTap: (name) => _toggle('author', name),
                ),
              ],
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                children: [
                  Expanded(
                    child: FilledButton(
                      // a count on the button, so nobody applies a filter to
                      // find out it leaves nothing
                      onPressed: _matching == 0
                          ? null
                          : () => Navigator.of(context).pop(_view),
                      child: Text(
                        _counting
                            ? 'Counting…'
                            : _matching == 0
                            ? 'Nothing matches'
                            : 'Show $_matching',
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

const Map<String, String> _titles = {
  'fandom': 'Fandoms',
  'relationship': 'Pairings',
  'character': 'Characters',
  'freeform': 'Tags',
};

/// Reading state, which is one choice rather than several.
class _StateSection extends StatelessWidget {
  const _StateSection({required this.chosen, required this.onChosen});

  final String chosen;
  final void Function(String) onChosen;

  static const List<(String, String)> _states = [
    ('all', 'Everything'),
    ('reading', 'Reading'),
    ('unread', 'Unread'),
    ('finished', 'Finished'),
    ('later', 'For later'),
    ('held', 'Downloaded'),
    ('known', 'Not downloaded'),
    ('bookmarked', 'Bookmarked'),
  ];

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
    child: Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final (value, label) in _states)
          _Pill(
            label: label,
            on: chosen == value,
            onTap: () => onChosen(value),
          ),
      ],
    ),
  );
}

/// One collapsible section of counted values.
class _Facet extends StatefulWidget {
  const _Facet({
    required this.title,
    required this.open,
    required this.onOpen,
    required this.chosen,
    required this.load,
    required this.onTap,
    this.searchable = true,
    super.key,
  });

  final String title;
  final bool open;
  final void Function(bool) onOpen;
  final List<String> chosen;
  final Future<List<Count>> Function(String needle) load;
  final void Function(String) onTap;
  final bool searchable;

  @override
  State<_Facet> createState() => _FacetState();
}

class _FacetState extends State<_Facet> {
  List<Count>? _counts;
  String _needle = '';
  bool _loading = false;

  @override
  void didUpdateWidget(_Facet old) {
    super.didUpdateWidget(old);
    if (widget.open && _counts == null) _load();
    if (old.chosen != widget.chosen && widget.open) _load();
  }

  @override
  void initState() {
    super.initState();
    if (widget.open) _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final counts = await widget.load(_needle);
      if (!mounted) return;
      setState(() {
        _counts = counts;
        _loading = false;
      });
    } catch (e) {
      /* json_each is absent from the oldest SQLite this can run on, and an
         Authors section is worth having and not worth a blank screen. */
      if (!mounted) return;
      setState(() {
        _counts = const [];
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        title: Text(
          widget.title,
          style: TextStyle(fontWeight: FontWeight.w600, color: ground.ink),
        ),
        initiallyExpanded: widget.open,
        onExpansionChanged: (open) {
          widget.onOpen(open);
          if (open && _counts == null) _load();
        },
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        children: [
          if (widget.searchable)
            TextField(
              decoration: InputDecoration(
                isDense: true,
                hintText: 'Search ${widget.title.toLowerCase()}',
                filled: true,
                fillColor: ground.sunken,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(Radii.field),
                  borderSide: BorderSide.none,
                ),
              ),
              onChanged: (value) {
                _needle = value;
                _load();
              },
            ),
          const SizedBox(height: 10),
          if (_loading)
            const Padding(
              padding: EdgeInsets.all(8),
              child: LinearProgressIndicator(),
            )
          else if ((_counts ?? const []).isEmpty)
            Text(
              'Nothing here to narrow by.',
              style: TextStyle(color: ground.inkFaint, fontSize: 13),
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final count in _counts!)
                  _Pill(
                    label: count.name,
                    n: count.n,
                    on: widget.chosen.contains(count.name),
                    onTap: () => widget.onTap(count.name),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({
    required this.label,
    required this.on,
    required this.onTap,
    this.n,
  });

  final String label;
  final bool on;
  final VoidCallback onTap;
  final int? n;

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    return Material(
      color: on ? ground.accent : ground.sunken,
      borderRadius: BorderRadius.circular(Radii.pill),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Radii.pill),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Text(
                  label,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: on ? ground.onAccent : ground.inkMid,
                  ),
                ),
              ),
              if (n != null) ...[
                const SizedBox(width: 6),
                Text(
                  '$n',
                  style: TextStyle(
                    fontSize: 12,
                    color: on
                        ? ground.onAccent.withValues(alpha: 0.75)
                        : ground.inkFaint,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
