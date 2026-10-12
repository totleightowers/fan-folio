import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'chapter_web.dart';
import 'library.dart';
import 'theme.dart';

/// Earlier copies are read independently of the current reading position.
class VersionsScreen extends StatefulWidget {
  const VersionsScreen({required this.library, required this.work, super.key});
  final Library library;
  final WorkRow work;

  @override
  State<VersionsScreen> createState() => _VersionsScreenState();
}

class _VersionsScreenState extends State<VersionsScreen> {
  late final _versions = widget.library.db.rawQuery(
    'SELECT id, number, title, reason, archived_at FROM chapter_versions '
    'WHERE work_id = ? ORDER BY archived_at DESC, number, id DESC',
    [widget.work.workId],
  );
  late final _skins = widget.library.db.rawQuery(
    'SELECT id, archived_at FROM skin_versions WHERE work_id = ? ORDER BY archived_at DESC, id DESC',
    [widget.work.workId],
  );

  Future<void> _open(Map<String, Object?> version) async {
    final rows = await widget.library.db.rawQuery(
      'SELECT * FROM chapter_versions WHERE id = ? AND work_id = ?',
      [version['id'], widget.work.workId],
    );
    if (!mounted || rows.isEmpty) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => EarlierCopyScreen(
          library: widget.library,
          work: widget.work,
          version: rows.single,
        ),
      ),
    );
  }

  Future<void> _skin(Map<String, Object?> version) async {
    final rows = await widget.library.db.rawQuery(
      'SELECT skin_css FROM skin_versions WHERE id = ? AND work_id = ?',
      [version['id'], widget.work.workId],
    );
    if (!mounted || rows.isEmpty) return;
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(title: const Text('Earlier work skin')),
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: SelectableText(
              '${version['archived_at']}\n\n${rows.single['skin_css'] ?? '(No work skin)'}',
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Earlier versions')),
    body: FutureBuilder<List<List<Map<String, Object?>>>>(
      future: Future.wait([_versions, _skins]),
      builder: (context, snapshot) {
        if (snapshot.hasError)
          return Center(
            child: Text('Could not load earlier copies: ${snapshot.error}'),
          );
        if (!snapshot.hasData)
          return const Center(child: CircularProgressIndicator());
        final chapters = snapshot.data![0];
        final skins = snapshot.data![1];
        return ListView(
          children: [
            Padding(
              padding: const EdgeInsets.all(20),
              child: Text(
                chapters.isEmpty && skins.isEmpty
                    ? 'No earlier copies saved for this work.'
                    : 'Earlier copies of ${widget.work.title}. Reading these keeps your current place unchanged.',
              ),
            ),
            for (final version in chapters)
              ListTile(
                leading: const Icon(Icons.history),
                title: Text(
                  'Chapter ${version['number']}${version['title'] == null ? '' : ' · ${version['title']}'}',
                ),
                subtitle: Text(
                  '${version['archived_at'] ?? 'Date unknown'} · ${version['reason'] ?? 'Changed'}',
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => _open(version),
              ),
            for (final version in skins)
              ListTile(
                leading: const Icon(Icons.palette_outlined),
                title: const Text('Work skin'),
                subtitle: Text('${version['archived_at'] ?? 'Date unknown'}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => _skin(version),
              ),
          ],
        );
      },
    ),
  );
}

class EarlierCopyScreen extends StatefulWidget {
  const EarlierCopyScreen({
    required this.library,
    required this.work,
    required this.version,
    super.key,
  });
  final Library library;
  final WorkRow work;
  final Map<String, Object?> version;

  @override
  State<EarlierCopyScreen> createState() => _EarlierCopyScreenState();
}

class _EarlierCopyScreenState extends State<EarlierCopyScreen> {
  bool _compare = false;
  bool _ready = false;
  String? _trouble;
  String? _current;
  String? _skin;
  core.ReadingPrefs _prefs = const core.ReadingPrefs();
  Map<String, ({String mime, Uint8List bytes})> _pictures = const {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      _current = await widget.library.chapterHtml(
        widget.work.workId,
        widget.version['number']! as int,
      );
      _prefs = await widget.library.readingPrefs();
      _pictures = await widget.library.picturesFor(widget.work.workId);
      // A skin archived at/after this chapter was the skin in use then.
      final skins = await widget.library.db.rawQuery(
        'SELECT skin_css FROM skin_versions WHERE work_id = ? AND archived_at >= ? '
        'ORDER BY archived_at, id LIMIT 1',
        [widget.work.workId, widget.version['archived_at'] ?? ''],
      );
      _skin = skins.isEmpty
          ? widget.work.skinCss
          : skins.first['skin_css'] as String?;
      if (mounted) setState(() => _ready = true);
    } catch (e) {
      if (mounted) setState(() => _trouble = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final html = widget.version['html'] as String? ?? '';
    return Scaffold(
      appBar: AppBar(
        title: Text('Earlier copy · chapter ${widget.version['number']}'),
        actions: [
          IconButton(
            tooltip: _compare
                ? 'Read earlier copy'
                : 'Compare with current copy',
            icon: Icon(
              _compare ? Icons.menu_book_outlined : Icons.compare_arrows,
            ),
            onPressed: () => setState(() => _compare = !_compare),
          ),
        ],
      ),
      body: _trouble != null
          ? Center(child: Text(_trouble!))
          : !_ready
          ? const Center(child: CircularProgressIndicator())
          : _compare
          ? ListView(
              padding: const EdgeInsets.all(20),
              children: [
                const Text(
                  'Earlier copy',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                SelectableText(core.htmlToText(html)),
                const Divider(height: 40),
                const Text(
                  'Current copy',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                SelectableText(
                  _current == null
                      ? 'This chapter is no longer in the current copy.'
                      : core.htmlToText(_current!),
                ),
              ],
            )
          : SkinnedChapterView(
              chapterHtml: html,
              skinCss: _skin,
              pictures: _pictures,
              settings: ReadingChrome.from(
                _prefs,
                ground: ground,
                dark: Theme.of(context).brightness == Brightness.dark,
              ),
              plainly: (_) => SingleChildScrollView(
                padding: const EdgeInsets.all(20),
                child: SelectableText(core.htmlToText(html)),
              ),
            ),
    );
  }
}
