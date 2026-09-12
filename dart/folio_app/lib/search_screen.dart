import 'dart:async';

import 'package:flutter/material.dart';

import 'library.dart';
import 'theme.dart';

/// Searching the library, which is the thing the sites it came from cannot do.
///
/// Two questions, not one. "A fic called X" and "a fic containing X" are
/// different, so they are different tabs rather than one box guessing — 1.x
/// learned that the hard way, with a box whose meaning depended on which
/// screen you happened to have been on.
class SearchScreen extends StatefulWidget {
  const SearchScreen({required this.library, required this.onOpen, super.key});

  final Library library;
  final void Function(String workId, {int chapter}) onOpen;

  @override
  State<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends State<SearchScreen> {
  final TextEditingController _box = TextEditingController();
  Timer? _settling;
  bool _inText = true;
  bool _running = false;
  List<Hit> _hits = const [];
  List<WorkRow> _works = const [];
  String? _trouble;

  @override
  void dispose() {
    _settling?.cancel();
    _box.dispose();
    super.dispose();
  }

  /// Asked once the typing stops. A query per keystroke over a million words
  /// is a search that fights the person doing it.
  void _typed(String _) {
    _settling?.cancel();
    _settling = Timer(const Duration(milliseconds: 350), _run);
  }

  Future<void> _run() async {
    final query = _box.text.trim();
    if (query.isEmpty) {
      setState(() {
        _hits = const [];
        _works = const [];
        _trouble = null;
      });
      return;
    }
    setState(() {
      _running = true;
      _trouble = null;
    });
    try {
      if (_inText) {
        final hits = await widget.library.searchText(query);
        if (!mounted) return;
        setState(() {
          _hits = hits;
          _running = false;
        });
      } else {
        final works = await widget.library.searchMeta(query);
        if (!mounted) return;
        setState(() {
          _works = works;
          _running = false;
        });
      }
    } catch (e) {
      if (!mounted) return;
      /* FTS refuses a malformed query — an unclosed quote, a bare operator —
         and saying so is better than an empty screen that looks like a
         library with nothing in it. */
      setState(() {
        _running = false;
        _trouble = 'That search was not one the index could answer.';
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
        title: TextField(
          controller: _box,
          autofocus: true,
          textInputAction: TextInputAction.search,
          onChanged: _typed,
          onSubmitted: (_) => _run(),
          decoration: InputDecoration(
            border: InputBorder.none,
            hintText: _inText
                ? 'Search every word held…'
                : 'Search titles and tags…',
            hintStyle: TextStyle(color: ground.inkFaint),
          ),
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(52),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
            child: SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: true, label: Text('In the text')),
                ButtonSegment(value: false, label: Text('Titles and tags')),
              ],
              selected: {_inText},
              onSelectionChanged: (s) {
                setState(() => _inText = s.first);
                _run();
              },
            ),
          ),
        ),
      ),
      body: _running
          ? const Center(child: CircularProgressIndicator())
          : _trouble != null
          ? Center(
              child: Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  _trouble!,
                  textAlign: TextAlign.center,
                  style: TextStyle(color: ground.inkMute),
                ),
              ),
            )
          : _inText
          ? _Passages(hits: _hits, ground: ground, onOpen: widget.onOpen)
          : _Works(works: _works, ground: ground, onOpen: widget.onOpen),
    );
  }
}

class _Passages extends StatelessWidget {
  const _Passages({
    required this.hits,
    required this.ground,
    required this.onOpen,
  });

  final List<Hit> hits;
  final Ground ground;
  final void Function(String workId, {int chapter}) onOpen;

  @override
  Widget build(BuildContext context) {
    if (hits.isEmpty) {
      return Center(
        child: Text('Nothing found.', style: TextStyle(color: ground.inkMute)),
      );
    }
    return ListView.separated(
      itemCount: hits.length,
      separatorBuilder: (_, __) => Divider(height: 1, color: ground.lineSoft),
      itemBuilder: (context, i) {
        final hit = hits[i];
        return InkWell(
          onTap: () => onOpen(hit.workId, chapter: hit.chapter),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  hit.title,
                  style: TextStyle(
                    fontFamily: titleFace,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: ground.ink,
                  ),
                ),
                Text(
                  '${hit.byline} · chapter ${hit.chapter}',
                  style: TextStyle(fontSize: 12.5, color: ground.inkFaint),
                ),
                const SizedBox(height: 6),
                // the snippet arrives with the matched words marked, so they
                // are shown as marked rather than as literal angle brackets
                Text.rich(
                  _marked(hit.snippet, ground),
                  style: TextStyle(
                    fontSize: 14,
                    height: 1.45,
                    color: ground.inkMid,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  /// `<<word>>` from SQLite's own snippet(), turned into emphasis.
  TextSpan _marked(String snippet, Ground ground) {
    final spans = <TextSpan>[];
    final pattern = RegExp('<<(.*?)>>', dotAll: true);
    var at = 0;
    for (final m in pattern.allMatches(snippet)) {
      if (m.start > at)
        spans.add(TextSpan(text: snippet.substring(at, m.start)));
      spans.add(
        TextSpan(
          text: m.group(1),
          style: TextStyle(color: ground.accent, fontWeight: FontWeight.w700),
        ),
      );
      at = m.end;
    }
    if (at < snippet.length) {
      spans.add(TextSpan(text: snippet.substring(at)));
    }
    return TextSpan(children: spans);
  }
}

class _Works extends StatelessWidget {
  const _Works({
    required this.works,
    required this.ground,
    required this.onOpen,
  });

  final List<WorkRow> works;
  final Ground ground;
  final void Function(String workId, {int chapter}) onOpen;

  @override
  Widget build(BuildContext context) {
    if (works.isEmpty) {
      return Center(
        child: Text('Nothing found.', style: TextStyle(color: ground.inkMute)),
      );
    }
    return ListView.separated(
      itemCount: works.length,
      separatorBuilder: (_, __) => Divider(height: 1, color: ground.lineSoft),
      itemBuilder: (context, i) => ListTile(
        title: Text(
          works[i].title,
          style: TextStyle(fontFamily: titleFace, fontWeight: FontWeight.w600),
        ),
        subtitle: Text(works[i].byline),
        onTap: () => onOpen(works[i].workId),
      ),
    );
  }
}
