import 'package:flutter/material.dart';

import 'downloads.dart';
import 'library.dart';
import 'signin_screen.dart';
import 'theme.dart';

/// Your own corner of it.
///
/// Signing in lived behind a gear, which is where a thing goes when nobody
/// has decided it matters — and it is the gate for half of what this app can
/// do. The counts beside it are the same: what you have bookmarked, what you
/// have read, what you meant to get to are facts about you rather than about
/// the library, and they were only reachable as filter combinations somebody
/// had to know to build.
class YouScreen extends StatefulWidget {
  const YouScreen({
    required this.library,
    required this.downloads,
    required this.onNarrow,
    required this.onBlocked,
    super.key,
  });

  final Library library;
  final Downloads? downloads;
  final void Function(Map<String, Object?> view, String title) onNarrow;
  final VoidCallback onBlocked;

  @override
  State<YouScreen> createState() => YouScreenState();
}

class YouScreenState extends State<YouScreen> {
  int _bookmarked = 0;
  int _read = 0;
  int _later = 0;
  int _blocked = 0;
  String? _lastSync;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    reload();
  }

  Future<void> reload() async {
    final counts = await widget.library.yours();
    final blocked = (await widget.library.blockedNames()).length;
    final synced = await widget.library.lastBookmarkSync();
    if (!mounted) return;
    setState(() {
      _lastSync = synced == null ? null : _when(synced);
      _bookmarked = counts.bookmarked;
      _read = counts.finished;
      _later = counts.later;
      _blocked = blocked;
      _loading = false;
    });
  }

  Future<void> _signIn() async {
    final downloads = widget.downloads;
    if (downloads == null) return;
    await Navigator.of(context).push(
      MaterialPageRoute<String>(
        builder: (_) => SignInScreen(downloads: downloads),
      ),
    );
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final downloads = widget.downloads;

    return ListView(
      padding: const EdgeInsets.only(bottom: 28),
      children: [
        if (downloads != null)
          ListenableBuilder(
            listenable: downloads,
            builder: (context, _) {
              final who = downloads.signedInAs;
              return _Account(
                who: who,
                ground: ground,
                lastSync: _lastSync,
                onSignIn: _signIn,
                onSignOut: downloads.signOut,
                onSync: who == null
                    ? null
                    : () async {
                        final messenger = ScaffoldMessenger.of(context);
                        try {
                          await downloads.syncBookmarks();
                          messenger.showSnackBar(
                            const SnackBar(
                              content: Text(
                                'Walking your bookmarks. Watch it in Activity.',
                              ),
                            ),
                          );
                        } catch (e) {
                          messenger.showSnackBar(SnackBar(content: Text('$e')));
                        }
                      },
              );
            },
          ),

        if (_loading)
          const Padding(
            padding: EdgeInsets.all(28),
            child: Center(child: CircularProgressIndicator()),
          )
        else ...[
          _Row(
            icon: Icons.bookmarks_outlined,
            label: 'Bookmarked',
            count: _bookmarked,
            ground: ground,
            onTap: () => widget.onNarrow(_bookmarked, 'Bookmarked'),
          ),
          _Row(
            icon: Icons.schedule_outlined,
            label: 'Marked for later',
            count: _later,
            ground: ground,
            onTap: () => widget.onNarrow(_later, 'Marked for later'),
          ),
          _Row(
            icon: Icons.done_all,
            label: 'Finished',
            count: _read,
            ground: ground,
            onTap: () => widget.onNarrow(_finished, 'Finished'),
          ),
          _Row(
            icon: Icons.person_off_outlined,
            label: 'Blocked authors',
            count: _blocked,
            ground: ground,
            onTap: widget.onBlocked,
          ),
        ],
      ],
    );
  }
}

class _Account extends StatelessWidget {
  const _Account({
    required this.who,
    required this.ground,
    required this.lastSync,
    required this.onSignIn,
    required this.onSignOut,
    required this.onSync,
  });

  final String? who;
  final Ground ground;

  /// Roughly when the bookmarks were last walked, which is all anybody wants
  /// from a last-run time.
  final String? lastSync;
  final VoidCallback onSignIn;
  final Future<void> Function() onSignOut;
  final VoidCallback? onSync;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.fromLTRB(16, 16, 16, 6),
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: ground.surface,
      borderRadius: BorderRadius.circular(Radii.card),
      border: Border.all(color: ground.lineSoft),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          who == null ? 'Not signed in' : who!,
          style: TextStyle(
            fontFamily: titleFace,
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: ground.ink,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          who == null
              ? 'Signing in lets the app fetch works locked to registered '
                    'readers, read your own bookmarks, and leave kudos. It '
                    'happens on the archive’s own page.'
              : lastSync == null
              ? 'Signing out here forgets the session. The archive still '
                    'holds it until you log out on the site.'
              : 'Bookmarks last walked $lastSync. Signing out forgets the '
                    'session; the archive holds it until you log out there.',
          style: TextStyle(fontSize: 13, height: 1.45, color: ground.inkMute),
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            if (who == null)
              FilledButton(onPressed: onSignIn, child: const Text('Sign in'))
            else ...[
              FilledButton.tonal(
                onPressed: onSync,
                child: const Text('Sync bookmarks'),
              ),
              const SizedBox(width: 8),
              TextButton(
                onPressed: () => onSignOut(),
                child: const Text('Sign out'),
              ),
            ],
          ],
        ),
      ],
    ),
  );
}

class _Row extends StatelessWidget {
  const _Row({
    required this.icon,
    required this.label,
    required this.count,
    required this.ground,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final int count;
  final Ground ground;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => ListTile(
    leading: Icon(icon, color: ground.inkMid),
    title: Text(label),
    // the number is the point of the row: nought of something is a row worth
    // seeing too, because it says the question has been asked
    trailing: Text(
      '$count',
      style: TextStyle(fontSize: 15, color: ground.inkMute),
    ),
    onTap: onTap,
  );
}

/// The three questions this screen asks of the library.
///
/// Held as constants rather than written at the call: the formatter splits a
/// map literal passed inline, and a split argument list then wants a trailing
/// comma the formatter takes away again.
const Map<String, Object?> _bookmarked = {
  'state': 'bookmarked',
  'sort': 'added',
};
const Map<String, Object?> _later = {'state': 'later', 'sort': 'title'};
const Map<String, Object?> _finished = {'state': 'finished', 'sort': 'added'};

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
