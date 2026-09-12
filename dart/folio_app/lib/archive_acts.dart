import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'downloads.dart';
import 'library.dart';
import 'theme.dart';

/// The three things that leave the phone.
///
/// Everything else this app does is reading. These write to somebody's
/// account on a public site: kudos are permanent, a comment notifies the
/// author, a bookmark appears on a profile. So they are gathered in one place
/// that says as much, rather than sitting among the reading controls where a
/// mis-tap costs something that cannot be taken back.
Future<void> showArchiveActs(
  BuildContext context, {
  required Downloads downloads,
  required WorkRow work,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (context) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
    child: _ArchiveActs(downloads: downloads, work: work),
  ),
);

class _ArchiveActs extends StatefulWidget {
  const _ArchiveActs({required this.downloads, required this.work});

  final Downloads downloads;
  final WorkRow work;

  @override
  State<_ArchiveActs> createState() => _ArchiveActsState();
}

class _ArchiveActsState extends State<_ArchiveActs> {
  bool _working = false;
  String? _said;

  Future<void> _run(Future<String> Function() act) async {
    setState(() {
      _working = true;
      _said = null;
    });
    try {
      final said = await act();
      if (!mounted) return;
      setState(() {
        _working = false;
        _said = said;
      });
    } on core.ArchiveError catch (e) {
      if (!mounted) return;
      setState(() {
        _working = false;
        _said = e.message;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _working = false;
        _said = '$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final workId = widget.work.workId;

    return SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'On the archive',
                  style: TextStyle(
                    fontFamily: titleFace,
                    fontSize: 18,
                    fontWeight: FontWeight.w600,
                    color: ground.ink,
                  ),
                ),
                Text(
                  'These leave this phone and cannot be undone from here.',
                  style: TextStyle(fontSize: 12.5, color: ground.inkMute),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),

          ListTile(
            leading: Icon(Icons.star_outline, color: ground.inkMid),
            title: const Text('Leave kudos'),
            subtitle: Text(
              'Once per work, and permanent.',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
            enabled: !_working,
            onTap: () => _run(() async {
              final already = await widget.downloads.leaveKudos(workId);
              return already ? 'You had already left kudos.' : 'Kudos left.';
            }),
          ),
          ListTile(
            leading: Icon(Icons.bookmark_add_outlined, color: ground.inkMid),
            title: const Text('Bookmark it'),
            subtitle: Text(
              'With your own notes and tags, if you want them.',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
            enabled: !_working,
            onTap: _bookmark,
          ),
          ListTile(
            leading: Icon(Icons.mode_comment_outlined, color: ground.inkMid),
            title: const Text('Leave a comment'),
            subtitle: Text(
              'The author is notified.',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
            enabled: !_working,
            onTap: _comment,
          ),

          if (_working)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 10),
              child: Center(child: CircularProgressIndicator()),
            ),
          if (_said != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
              child: Text(
                _said!,
                style: TextStyle(
                  fontSize: 13,
                  height: 1.4,
                  color: ground.inkMid,
                ),
              ),
            ),
          const SizedBox(height: 10),
        ],
      ),
    );
  }

  Future<void> _bookmark() async {
    final asked = await showDialog<_Bookmark>(
      context: context,
      builder: (context) => const _BookmarkDialog(),
    );
    if (asked == null) return;
    await _run(() async {
      await widget.downloads.bookmark(
        widget.work.workId,
        notes: asked.notes,
        tags: asked.tags,
        private: asked.private,
        rec: asked.rec,
      );
      return 'Bookmarked.';
    });
  }

  Future<void> _comment() async {
    final said = await showDialog<String>(
      context: context,
      builder: (context) => const _CommentDialog(),
    );
    if (said == null || said.trim().isEmpty) return;
    await _run(() async {
      await widget.downloads.comment(widget.work.workId, said);
      return 'Comment left.';
    });
  }
}

class _Bookmark {
  const _Bookmark({
    required this.notes,
    required this.tags,
    required this.private,
    required this.rec,
  });

  final String notes;
  final String tags;
  final bool private;
  final bool rec;
}

class _BookmarkDialog extends StatefulWidget {
  const _BookmarkDialog();

  @override
  State<_BookmarkDialog> createState() => _BookmarkDialogState();
}

class _BookmarkDialogState extends State<_BookmarkDialog> {
  final TextEditingController _notes = TextEditingController();
  final TextEditingController _tags = TextEditingController();
  bool _private = false;
  bool _rec = false;

  @override
  void dispose() {
    _notes.dispose();
    _tags.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Bookmark'),
    content: SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextField(
            controller: _notes,
            maxLines: 3,
            decoration: const InputDecoration(
              labelText: 'Notes',
              hintText: 'Only you will read these, unless it is public.',
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _tags,
            decoration: const InputDecoration(
              labelText: 'Tags',
              hintText: 'comma, separated',
            ),
          ),
          /* Both of these default off, which is what the archive's own form
             defaults to, and the difference between them matters: private is
             who can see it, rec is whether it is a recommendation. */
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Private'),
            value: _private,
            onChanged: (on) => setState(() => _private = on),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Mark as a rec'),
            value: _rec,
            onChanged: (on) => setState(() => _rec = on),
          ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Not now'),
      ),
      FilledButton(
        onPressed: () => Navigator.of(context).pop(
          _Bookmark(
            notes: _notes.text,
            tags: _tags.text,
            private: _private,
            rec: _rec,
          ),
        ),
        child: const Text('Bookmark'),
      ),
    ],
  );
}

class _CommentDialog extends StatefulWidget {
  const _CommentDialog();

  @override
  State<_CommentDialog> createState() => _CommentDialogState();
}

class _CommentDialogState extends State<_CommentDialog> {
  final TextEditingController _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Leave a comment'),
    content: TextField(
      controller: _text,
      autofocus: true,
      maxLines: 6,
      minLines: 3,
      decoration: const InputDecoration(
        hintText: 'The author is notified, and it is public.',
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.of(context).pop(),
        child: const Text('Not now'),
      ),
      FilledButton(
        onPressed: () => Navigator.of(context).pop(_text.text),
        child: const Text('Post it'),
      ),
    ],
  );
}
