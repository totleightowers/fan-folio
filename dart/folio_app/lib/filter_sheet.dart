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
  bool _excluding = false;
  int _revision = 0;

  /// Which sections are open. A panel that opens with everything expanded is
  /// a wall; one that opens with everything closed is a list of words.
  final Set<String> _open = {'fandom'};

  @override
  void initState() {
    super.initState();
    if (const [
      'later',
      'bookmarked',
      'history',
      'rec',
    ].contains(_view['state'])) {
      _view['collection'] = _view.remove('state');
    }
    if (const ['held', 'known'].contains(_view['state'])) {
      _view['availability'] = _view.remove('state');
    }
    _recount();
  }

  Future<void> _recount() async {
    final revision = ++_revision;
    setState(() => _counting = true);
    final n = await widget.library.count(_view);
    if (!mounted || revision != _revision) return;
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

  void _set(String key, String? value) {
    setState(() {
      if (value == null || value.isEmpty) {
        _view.remove(key);
      } else {
        _view[key] = value;
      }
    });
    _recount();
  }

  Widget _choice(String label, String key, Map<String, String> choices) =>
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: DropdownButtonFormField<String>(
          key: ValueKey('$key:${_view[key]}'),
          initialValue: choices.containsKey('${_view[key] ?? ''}')
              ? '${_view[key] ?? ''}'
              : choices.keys.first,
          isExpanded: true,
          decoration: InputDecoration(labelText: label),
          items: [
            for (final e in choices.entries)
              DropdownMenuItem(value: e.key, child: Text(e.value)),
          ],
          onChanged: (value) => _set(key, value),
        ),
      );

  Widget _rangeField(String label, String key, {bool date = false}) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
    child: TextFormField(
      key: ValueKey('$key:${_view[key] == null}'),
      initialValue: '${_view[key] ?? ''}',
      decoration: InputDecoration(
        labelText: label,
        hintText: date ? 'YYYY-MM-DD' : 'Any',
      ),
      keyboardType: date ? TextInputType.datetime : TextInputType.number,
      onChanged: (value) => _set(key, value.trim()),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.85,
        builder: (context, scroll) => Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 8, 6),
              child: Row(
                children: [
                  Text(
                    'View & filters',
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
                  _choice('Sort', 'sort', const {
                    'added': 'Recently added',
                    'recent': 'Recently read',
                    'visits': 'Most read',
                    'title': 'Title',
                    'author': 'Author',
                    'updated': 'Recently updated',
                    'published': 'Publication date',
                    'words': 'Longest first',
                    'shortest': 'Shortest first',
                    'chapters': 'Most chapters',
                    'kudos': 'Most kudos',
                    'bookmarks': 'Most bookmarks',
                    'hits': 'Most hits',
                    'random': 'Random',
                  }),
                  _choice('Descriptions', 'density', const {
                    '': 'Full descriptions',
                    'compact': 'Compact',
                  }),
                  _choice('Availability', 'availability', const {
                    '': 'All availability',
                    'held': 'Downloaded',
                    'known': 'Not downloaded',
                  }),
                  _choice('Collection', 'collection', const {
                    '': 'Any collection',
                    'later': 'For later',
                    'bookmarked': 'AO3 bookmarks',
                    'history': 'AO3 history',
                    'rec': 'Recommended on AO3',
                  }),
                  _StateSection(
                    chosen: '${_view['state'] ?? 'all'}',
                    onChosen: (state) {
                      setState(() => _view['state'] = state);
                      _recount();
                    },
                  ),
                  SwitchListTile(
                    title: const Text('OTP only'),
                    subtitle: const Text(
                      'Exactly one relationship tag, as in AO3’s otp:true filter.',
                    ),
                    value:
                        _view['otp'] == '1' ||
                        _view['otp'] == true ||
                        _view['otp'] == 1,
                    onChanged: (yes) => _set('otp', yes ? '1' : null),
                  ),
                  _choice('Completion', 'complete', const {
                    '': 'Any completion',
                    '1': 'Complete',
                    '0': 'In progress',
                  }),
                  _choice('Crossovers', 'crossover', const {
                    '': 'Include crossovers',
                    '0': 'Exclude crossovers',
                    '1': 'Only crossovers',
                  }),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: Wrap(
                      spacing: 8,
                      children: [
                        ChoiceChip(
                          label: const Text('Include tags'),
                          selected: !_excluding,
                          onSelected: (_) => setState(() => _excluding = false),
                        ),
                        ChoiceChip(
                          label: const Text('Exclude tags'),
                          selected: _excluding,
                          onSelected: (_) => setState(() => _excluding = true),
                        ),
                        for (final key in ['include', 'exclude'])
                          for (final tag in _chosen(key))
                            InputChip(
                              label: Text(
                                '${key == 'exclude' ? 'Exclude: ' : ''}$tag',
                              ),
                              onDeleted: () => _toggle(key, tag),
                            ),
                      ],
                    ),
                  ),
                  for (final kind in const [
                    'fandom',
                    'relationship',
                    'character',
                    'freeform',
                    'warning',
                    'category',
                  ])
                    _Facet(
                      key: ValueKey('$kind:$_excluding'),
                      title: _titles[kind]!,
                      open: _open.contains(kind),
                      onOpen: (yes) => setState(
                        () => yes ? _open.add(kind) : _open.remove(kind),
                      ),
                      revision: _revision,
                      chosen: _chosen(_excluding ? 'exclude' : 'include'),
                      load: (needle) => widget.library.facet(
                        core.tagFacet(
                          _excluding
                              ? {..._view, 'exclude': <String>[]}
                              : _view,
                          kind,
                          needle: needle,
                        ),
                      ),
                      onTap: (name) =>
                          _toggle(_excluding ? 'exclude' : 'include', name),
                    ),
                  _Facet(
                    title: 'Rating',
                    open: _open.contains('rating'),
                    onOpen: (yes) => setState(
                      () => yes ? _open.add('rating') : _open.remove('rating'),
                    ),
                    chosen: _chosen('rating'),
                    revision: _revision,
                    searchable: false,
                    load: (_) =>
                        widget.library.facet(core.columnFacet(_view, 'rating')),
                    onTap: (name) => _toggle('rating', name),
                  ),
                  _Facet(
                    revision: _revision,
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
                  _Facet(
                    title: 'Language',
                    open: _open.contains('language'),
                    onOpen: (yes) => setState(
                      () => yes
                          ? _open.add('language')
                          : _open.remove('language'),
                    ),
                    revision: _revision,
                    chosen: [
                      if (_view['language'] != null) '${_view['language']}',
                    ],
                    load: (_) => widget.library.facet(
                      core.columnFacet(_view, 'language'),
                    ),
                    onTap: (name) => _set(
                      'language',
                      _view['language'] == name ? null : name,
                    ),
                  ),
                  ExpansionTile(
                    title: const Text('Length and dates'),
                    children: [
                      _rangeField('Minimum words', 'wordsMin'),
                      _rangeField('Maximum words', 'wordsMax'),
                      _rangeField('Minimum chapters', 'chaptersMin'),
                      _rangeField('Maximum chapters', 'chaptersMax'),
                      _rangeField(
                        'Updated on or after',
                        'updatedAfter',
                        date: true,
                      ),
                      _rangeField(
                        'Updated on or before',
                        'updatedBefore',
                        date: true,
                      ),
                    ],
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
                        onPressed: _counting || _matching == 0
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
      ),
    );
  }
}

const Map<String, String> _titles = {
  'fandom': 'Fandoms',
  'relationship': 'Pairings',
  'character': 'Characters',
  'freeform': 'Tags',
  'warning': 'Warnings',
  'category': 'Categories',
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
    this.revision = 0,
    super.key,
  });

  final String title;
  final bool open;
  final void Function(bool) onOpen;
  final List<String> chosen;
  final Future<List<Count>> Function(String needle) load;
  final void Function(String) onTap;
  final bool searchable;
  final int revision;

  @override
  State<_Facet> createState() => _FacetState();
}

class _FacetState extends State<_Facet> {
  List<Count>? _counts;
  String _needle = '';
  bool _loading = false;
  int _generation = 0;

  @override
  void didUpdateWidget(_Facet old) {
    super.didUpdateWidget(old);
    if (widget.open && _counts == null) _load();
    if ((old.chosen != widget.chosen || old.revision != widget.revision) &&
        widget.open) {
      _load();
    }
  }

  @override
  void initState() {
    super.initState();
    if (widget.open) _load();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() => _loading = true);
    try {
      final counts = await widget.load(_needle);
      if (!mounted || generation != _generation) return;
      setState(() {
        _counts = counts;
        _loading = false;
      });
    } catch (e) {
      /* json_each is absent from the oldest SQLite this can run on, and an
         Authors section is worth having and not worth a blank screen. */
      if (!mounted || generation != _generation) return;
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
