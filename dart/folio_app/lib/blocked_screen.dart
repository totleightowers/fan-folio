import 'package:flutter/material.dart';

import 'library.dart';
import 'theme.dart';

/// Who is blocked, and the way back.
///
/// Blocking hides every work that is solely theirs, which means the sheet that
/// did the blocking can no longer be reached — there is no work left to hold.
/// Without this screen a block is one-way, and a setting you cannot undo is a
/// trap rather than a control.
class BlockedScreen extends StatefulWidget {
  const BlockedScreen({required this.library, super.key});

  final Library library;

  @override
  State<BlockedScreen> createState() => _BlockedScreenState();
}

class _BlockedScreenState extends State<BlockedScreen> {
  List<String>? _names;

  /// Whether anything changed, so the library behind this knows to ask again.
  bool _changed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final names = await widget.library.blockedNames();
    if (!mounted) return;
    setState(() => _names = names);
  }

  Future<void> _unblock(String name) async {
    await widget.library.setBlocked(name, blocked: false);
    _changed = true;
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final names = _names;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        appBar: AppBar(title: const Text('Blocked authors')),
        body: names == null
            ? const Center(child: CircularProgressIndicator())
            : names.isEmpty
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Text(
                    'Nobody is blocked.\n\nHold a work to block its author: '
                    'nothing of theirs is fetched again, and anything that is '
                    'only theirs stops being shown.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: ground.inkMute, height: 1.5),
                  ),
                ),
              )
            : ListView.separated(
                itemCount: names.length,
                separatorBuilder: (_, __) =>
                    Divider(height: 1, color: ground.lineSoft),
                itemBuilder: (context, i) => ListTile(
                  leading: Icon(Icons.person_off, color: ground.inkMute),
                  title: Text(names[i]),
                  trailing: TextButton(
                    onPressed: () => _unblock(names[i]),
                    child: const Text('Unblock'),
                  ),
                ),
              ),
      ),
    );
  }
}
