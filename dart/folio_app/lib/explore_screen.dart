import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'discovery_store.dart';
import 'downloads.dart';
import 'library.dart';
import 'theme.dart';
import 'work_card.dart';

/// A browsing session belongs to its route: opening a result, switching tabs
/// or reading a chapter does not repeat its request or lose its position.
class ExploreScreen extends StatefulWidget {
  const ExploreScreen({
    required this.library,
    required this.downloads,
    required this.onOpen,
    required this.onLibrarySearch,
    this.initialSearch,
    super.key,
  });
  final Library library;
  final Downloads downloads;
  final ValueChanged<core.Blurb> onOpen;
  final VoidCallback onLibrarySearch;
  final core.ArchiveSearch? initialSearch;
  @override
  State<ExploreScreen> createState() => _ExploreScreenState();
}

class _ExploreScreenState extends State<ExploreScreen> {
  final _query = TextEditingController();
  final _scroll = ScrollController();
  late core.ArchiveSearch _search =
      widget.initialSearch ?? const core.ArchiveSearch();
  core.Listing? _results;
  core.ArchiveSearch? _resultsSearch;
  List<SavedSearch> _saved = [];
  List<Count> _fandoms = [];
  Set<String> _newIds = {};
  Set<String> _held = {};
  String? _error;
  bool _busy = false;
  int _request = 0;
  String? _savedId;
  String? _resultsSavedId;
  bool _checkedUpdates = false;
  int _retryPage = 1;
  SavedSearch? _retryCheck;

  @override
  void initState() {
    super.initState();
    _query.text = _search.fields['query'] ?? '';
    _loadSaved();
    _loadFandoms();
    widget.downloads.addListener(_refreshAvailability);
    if (widget.initialSearch != null) _run();
  }

  @override
  void dispose() {
    widget.downloads.removeListener(_refreshAvailability);
    _request++;
    _query.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _refreshAvailability() async {
    final results = _results;
    if (results == null || results.works.isEmpty) return;
    final ids = results.works.map((w) => w.workId).toList();
    final marks = List.filled(ids.length, '?').join(',');
    final rows = await widget.library.db.rawQuery(
      "SELECT DISTINCT work_id FROM chapters WHERE work_id IN ($marks) AND length(COALESCE(html, '')) > 0",
      ids,
    );
    if (!mounted || results != _results) return;
    final held = rows.map((r) => '${r['work_id']}').toSet();
    if (held.length == _held.length && held.containsAll(_held)) return;
    setState(() => _held = held);
  }

  Future<void> _loadSaved() async {
    final saved = await DiscoveryStore(widget.library).all();
    if (mounted) setState(() => _saved = saved);
  }

  Future<void> _loadFandoms() async {
    final browse = await widget.library.browse();
    if (mounted) {
      setState(() => _fandoms = (browse['fandom'] ?? []).take(6).toList());
    }
  }

  Future<void> _run({
    int page = 1,
    SavedSearch? checking,
    core.ArchiveSearch? searchOverride,
  }) async {
    // One user-initiated request at a time; typing never contacts the archive.
    if (_busy) return;
    final token = ++_request;
    if (searchOverride != null) {
      _search = searchOverride;
      _savedId = _resultsSavedId;
      _query.text = _search.fields['query'] ?? '';
    }
    final search = _search;
    final savedId = _savedId;
    _retryPage = page;
    _retryCheck = checking;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final results = await widget.downloads.discover(search, page: page);
      if (!mounted || token != _request) return;
      var fresh = <String>{};
      if (checking != null) {
        fresh = results.works
            .map((w) => w.workId)
            .toSet()
            .difference(checking.seen.toSet());
        await DiscoveryStore(widget.library).save(
          SavedSearch(
            id: checking.id,
            name: checking.name,
            search: checking.search,
            seen: {
              ...results.works.map((w) => w.workId),
              ...checking.seen,
            }.take(1000).toList(),
            checked: DateTime.now().toUtc().toIso8601String(),
          ),
        );
        if (!mounted || token != _request) return;
        await _loadSaved();
      }
      if (!mounted || token != _request) return;
      setState(() {
        _results = results;
        _resultsSearch = search;
        _resultsSavedId = savedId;
        _newIds = fresh;
        _checkedUpdates = checking != null;
      });
      await _refreshAvailability();
      if (_scroll.hasClients) _scroll.jumpTo(0);
    } catch (e) {
      if (mounted && token == _request) setState(() => _error = '$e');
    } finally {
      if (mounted && token == _request) setState(() => _busy = false);
    }
  }

  void _submit() {
    FocusScope.of(context).unfocus();
    _search = core.ArchiveSearch(
      fields: {
        ..._search.fields,
        if (_search.author != null) 'creators': _search.author!,
        'query': _query.text,
      },
    );
    _savedId = null;
    _run();
  }

  Future<void> _filters() async {
    FocusScope.of(context).unfocus();
    final chosen = await showModalBottomSheet<core.ArchiveSearch>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => ArchiveSearchSheet(search: _search),
    );
    if (chosen == null || !mounted) return;
    setState(() {
      _search = chosen;
      _query.text = chosen.fields['query'] ?? '';
      _savedId = null;
    });
    _run();
  }

  Future<void> _save() async {
    final search = _resultsSearch;
    if (search == null) return;
    var name = search.label.isEmpty ? 'My AO3 search' : search.label;
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Save this search'),
        content: TextFormField(
          initialValue: name,
          onChanged: (value) => name = value,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Name'),
          onFieldSubmitted: (value) {
            if (value.trim().isNotEmpty) Navigator.pop(context, value.trim());
          },
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (name.trim().isNotEmpty) {
                Navigator.pop(context, name.trim());
              }
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (value == null || !mounted) return;
    final id =
        _resultsSavedId ?? DateTime.now().microsecondsSinceEpoch.toString();
    await DiscoveryStore(widget.library).save(
      SavedSearch(
        id: id,
        name: value,
        search: search,
        seen: _results!.works.map((w) => w.workId).toList(),
        checked: DateTime.now().toUtc().toIso8601String(),
      ),
    );
    if (!mounted) return;
    _savedId = id;
    _resultsSavedId = id;
    await _loadSaved();
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Search saved.')));
    }
  }

  void _openSaved(SavedSearch saved, {bool check = false}) {
    setState(() {
      _search = saved.search;
      _query.text = saved.search.fields['query'] ?? '';
      _savedId = saved.id;
    });
    _run(checking: check ? saved : null);
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final results = _results;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 16,
            children: [
              const Text('Search AO3'),
              TextButton(
                onPressed: widget.onLibrarySearch,
                child: const Text('Search my library'),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _query,
                  enabled: !_busy,
                  textInputAction: TextInputAction.search,
                  decoration: const InputDecoration(
                    hintText: 'Stories, fandoms, pairings…',
                    prefixIcon: Icon(Icons.search),
                  ),
                  onSubmitted: (_) => _submit(),
                ),
              ),
              IconButton(
                tooltip: 'AO3 filters',
                onPressed: _busy ? null : _filters,
                icon: const Icon(Icons.filter_alt_outlined),
              ),
              IconButton(
                tooltip: 'Search AO3',
                onPressed: _busy ? null : _submit,
                icon: const Icon(Icons.arrow_forward),
              ),
            ],
          ),
        ),
        if (_search.author != null ||
            _search.fields.entries.any(
              (e) => e.key != 'query' && e.value.isNotEmpty,
            ))
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                _search.label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: ground.inkMute),
              ),
            ),
          ),
        if (_busy) ...[
          const LinearProgressIndicator(),
          Padding(
            padding: const EdgeInsets.all(8),
            child: ListenableBuilder(
              listenable: widget.downloads,
              builder: (_, __) => Text(
                widget.downloads.cooling != null
                    ? 'AO3 asked us to wait. Your search is queued.'
                    : 'Waiting for AO3… existing results stay here.',
              ),
            ),
          ),
        ],
        if (_error != null)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _error!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => _run(page: _retryPage, checking: _retryCheck),
                  child: const Text('Retry'),
                ),
              ],
            ),
          ),
        Expanded(
          child: ListView(
            controller: _scroll,
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: [
              if (results == null) ...[
                if (_fandoms.isNotEmpty) ...[
                  const Text(
                    'Explore your fandoms',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      for (final f in _fandoms)
                        ActionChip(
                          label: Text(f.name),
                          onPressed: _busy
                              ? null
                              : () {
                                  _search = core.ArchiveSearch(
                                    fields: {
                                      'fandom_names': f.name,
                                      'sort_column': 'revised_at',
                                      'sort_direction': 'desc',
                                    },
                                  );
                                  _query.clear();
                                  _savedId = null;
                                  _run();
                                },
                        ),
                    ],
                  ),
                ],
                if (_saved.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  const Text(
                    'Saved searches',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  for (final saved in _saved)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(saved.name),
                      subtitle: const Text(
                        'Open the search or check its first page for new results',
                      ),
                      onTap: _busy ? null : () => _openSaved(saved),
                      trailing: PopupMenuButton<String>(
                        tooltip: 'Saved search actions',
                        enabled: !_busy,
                        onSelected: (action) async {
                          if (action == 'check') {
                            _openSaved(saved, check: true);
                          } else {
                            await DiscoveryStore(widget.library)
                                .remove(saved.id);
                            await _loadSaved();
                          }
                        },
                        itemBuilder: (_) => const [
                          PopupMenuItem(
                            value: 'check',
                            child: Text('Check for new results'),
                          ),
                          PopupMenuItem(
                            value: 'remove',
                            child: Text('Remove saved search'),
                          ),
                        ],
                      ),
                    ),
                ],
                if (_fandoms.isEmpty && _saved.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 24),
                    child: Text(
                      'Find your next story on AO3. Use filters for an author, fandom, relationship or rating.',
                    ),
                  ),
              ] else ...[
                Wrap(
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 12,
                  children: [
                    Text(
                      'Page ${results.current} of ${results.total} · ${results.works.length} works',
                    ),
                    TextButton.icon(
                      onPressed: _busy ? null : _save,
                      icon: const Icon(Icons.bookmark_add_outlined),
                      label: const Text('Save search'),
                    ),
                    TextButton(
                      onPressed: _busy
                          ? null
                          : () => setState(() {
                              _results = null;
                              _resultsSearch = null;
                            }),
                      child: const Text('Saved searches'),
                    ),
                  ],
                ),
                if (_checkedUpdates)
                  Text(
                    '${_newIds.length} new results on the first page since the last check.',
                    style: TextStyle(color: ground.inkMute),
                  ),
                if (results.works.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Text(
                      'No matching works. Try changing your search or filters.',
                    ),
                  ),
                for (final b in results.works) ...[
                  if (_newIds.contains(b.workId))
                    const Text(
                      'New result',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                  WorkRowTile(
                    work: workFromBlurb(b, hasText: _held.contains(b.workId)),
                    onTap: () => widget.onOpen(b),
                  ),
                  Divider(height: 1, color: ground.lineSoft),
                ],
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    TextButton.icon(
                      onPressed: _busy || results.current <= 1
                          ? null
                          : () => _run(
                              page: results.current - 1,
                              searchOverride: _resultsSearch,
                            ),
                      icon: const Icon(Icons.chevron_left),
                      label: const Text('Previous'),
                    ),
                    TextButton.icon(
                      onPressed: _busy || results.current >= results.total
                          ? null
                          : () => _run(
                              page: results.current + 1,
                              searchOverride: _resultsSearch,
                            ),
                      icon: const Icon(Icons.chevron_right),
                      label: const Text('Next'),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class ArchiveSearchSheet extends StatefulWidget {
  const ArchiveSearchSheet({required this.search, super.key});
  final core.ArchiveSearch search;
  @override
  State<ArchiveSearchSheet> createState() => _ArchiveSearchSheetState();
}

class _ArchiveSearchSheetState extends State<ArchiveSearchSheet> {
  static const labels = {
    'query': 'Keywords (AO3 search syntax)',
    'title': 'Title',
    'creators': 'Author',
    'fandom_names': 'Fandoms',
    'relationship_names': 'Relationships',
    'character_names': 'Characters',
    'freeform_names': 'Additional tags',
    'word_count': 'Word count (e.g. 1000-50000)',
  };
  late final controllers = {
    for (final key in labels.keys)
      key: TextEditingController(
        text:
            (key == 'creators' ? widget.search.author : null) ??
            widget.search.fields[key] ??
            '',
      ),
  };
  late String language = widget.search.fields['language_id'] ?? '';
  late String complete = widget.search.fields['complete'] ?? '';
  late String crossover = widget.search.fields['crossover'] ?? '';
  late String rating = widget.search.fields['rating_ids'] ?? '';
  late String sort = widget.search.fields['sort_column'] ?? 'revised_at';
  late String direction = widget.search.fields['sort_direction'] ?? 'desc';
  @override
  void dispose() {
    for (final c in controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  Widget choice(
    String label,
    String value,
    Map<String, String> options,
    ValueChanged<String> change,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: DropdownButtonFormField<String>(
      key: ValueKey('$label:$value'),
      initialValue: value,
      isExpanded: true,
      decoration: InputDecoration(labelText: label),
      items: [
        for (final e in options.entries)
          DropdownMenuItem(value: e.key, child: Text(e.value)),
      ],
      onChanged: (v) => setState(() => change(v!)),
    ),
  );
  @override
  Widget build(BuildContext context) => SafeArea(
    child: SizedBox(
      height: MediaQuery.sizeOf(context).height * .85,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                const Expanded(
                  child: Text(
                    'Search AO3',
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
                  ),
                ),
                TextButton(
                  onPressed: () {
                    for (final c in controllers.values) {
                      c.clear();
                    }
                    setState(() {
                      language = '';
                      complete = '';
                      crossover = '';
                      rating = '';
                      sort = 'revised_at';
                      direction = 'desc';
                    });
                  },
                  child: const Text('Clear'),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: EdgeInsets.fromLTRB(
                16,
                12,
                16,
                MediaQuery.viewInsetsOf(context).bottom + 16,
              ),
              children: [
                for (final e in labels.entries)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: TextField(
                      controller: controllers[e.key],
                      decoration: InputDecoration(labelText: e.value),
                    ),
                  ),
                choice(
                  'Language',
                  language,
                  {
                    '': 'Any',
                    'en': 'English',
                    'es': 'Spanish',
                    'fr': 'French',
                    'de': 'German',
                    'pt-br': 'Portuguese (Brazil)',
                    'zh': 'Chinese',
                    if (![
                      '',
                      'en',
                      'es',
                      'fr',
                      'de',
                      'pt-br',
                      'zh',
                    ].contains(language))
                      language: language,
                  },
                  (v) {
                    language = v;
                  },
                ),
                choice(
                  'Completion',
                  complete,
                  {'': 'Any', 'T': 'Complete', 'F': 'In progress'},
                  (v) {
                    complete = v;
                  },
                ),
                choice(
                  'Crossovers',
                  crossover,
                  {
                    '': 'Any',
                    'F': 'Exclude crossovers',
                    'T': 'Only crossovers',
                  },
                  (v) {
                    crossover = v;
                  },
                ),
                choice(
                  'Rating',
                  rating,
                  {
                    '': 'Any',
                    '9': 'Not Rated',
                    '10': 'General Audiences',
                    '11': 'Teen And Up Audiences',
                    '12': 'Mature',
                    '13': 'Explicit',
                  },
                  (v) {
                    rating = v;
                  },
                ),
                choice(
                  'Sort',
                  sort,
                  {
                    'revised_at': 'Updated',
                    'created_at': 'Posted',
                    'title_to_sort_on': 'Title',
                    'word_count': 'Word count',
                    'kudos_count': 'Kudos',
                    'hits': 'Hits',
                    'bookmarks_count': 'Bookmarks',
                  },
                  (v) {
                    sort = v;
                  },
                ),
                choice(
                  'Direction',
                  direction,
                  {'desc': 'Descending', 'asc': 'Ascending'},
                  (v) {
                    direction = v;
                  },
                ),
                const Text(
                  'For exclusions, use AO3 search syntax in Keywords, such as -"unwanted tag".',
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () => Navigator.pop(
                  context,
                  core.ArchiveSearch(
                    fields: {
                      for (final e in controllers.entries)
                        e.key: e.value.text.trim(),
                      'language_id': language,
                      'complete': complete,
                      'crossover': crossover,
                      'rating_ids': rating,
                      'sort_column': sort,
                      'sort_direction': direction,
                    },
                  ),
                ),
                child: const Text('Show results'),
              ),
            ),
          ),
        ],
      ),
    ),
  );
}
