import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'downloads.dart';
import 'library.dart';
import 'theme.dart';

/// What you can do to a work that is not reading it.
///
/// Both of these are the library getting smaller, which is the one direction
/// it does not recover from on its own, so both say plainly what they are
/// about to do and neither happens on a single tap.
Future<bool> showWorkActions(
  BuildContext context, {
  required Library library,
  required WorkRow work,
}) async {
  final blocked = (await library.blockedNames()).toSet();
  if (!context.mounted) return false;

  final changed = await showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    builder: (context) =>
        _WorkActions(library: library, work: work, blocked: blocked),
  );
  return changed ?? false;
}

class _WorkActions extends StatelessWidget {
  const _WorkActions({
    required this.library,
    required this.work,
    required this.blocked,
    this.downloads,
  });

  final Library library;
  final WorkRow work;
  final Set<String> blocked;
  final Downloads? downloads;

  /// Ask before committing an hour of somebody's evening.
  ///
  /// Under the threshold the whole listing is a handful of requests and waiting
  /// for a tap only adds a tap. Over it, the reader is spending minutes of their
  /// own time and of the archive's patience, and should get to say so — so the
  /// size is found first, which costs exactly one request.
  Future<void> _fetchAuthor(BuildContext context, String name) async {
    final sheet = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final downloads = this.downloads;
    if (downloads == null) return;

    core.ListingCost cost;
    try {
      cost = await downloads.costOfAuthor(name);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('$e')));
      return;
    }

    if (!core.shouldWalkWholeListing(cost.pages)) {
      final sure = await showDialog<bool>(
        context: sheet.context,
        builder: (context) => AlertDialog(
          title: Text('All of $name?'),
          content: Text(
            'They have about ${cost.works} works across ${cost.pages} pages. '
            'Fetched at a reader’s pace that is roughly '
            '${_hours(cost.minutes)} — it carries on while the app is open, '
            'and you can pause it in Activity.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Not now'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Go on then'),
            ),
          ],
        ),
      );
      if (sure != true) return;
    }

    await downloads.addAuthor(name);
    sheet.pop(true);
    messenger.showSnackBar(
      SnackBar(content: Text('Walking $name’s works. Watch it in Activity.')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);

    return SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  work.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: titleFace,
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                    color: ground.ink,
                  ),
                ),
                Text(
                  work.byline,
                  style: TextStyle(fontSize: 13, color: ground.inkMute),
                ),
              ],
            ),
          ),
          Divider(height: 1, color: ground.lineSoft),

          /* One entry per author, because a work having more than one is
             ordinary and both of these are about a person rather than a
             work. */
          for (final name in work.authors) ...[
            if (downloads != null && !blocked.contains(name))
              ListTile(
                leading: Icon(Icons.library_add_outlined, color: ground.inkMid),
                title: Text('Everything by $name'),
                subtitle: Text(
                  'Walk their works and fetch what is not here yet.',
                  style: TextStyle(fontSize: 12.5, color: ground.inkMute),
                ),
                onTap: () => _fetchAuthor(context, name),
              ),
            ListTile(
              leading: Icon(
                blocked.contains(name) ? Icons.person : Icons.person_off,
                color: ground.inkMid,
              ),
              title: Text(
                blocked.contains(name) ? 'Unblock $name' : 'Block $name',
              ),
              subtitle: Text(
                blocked.contains(name)
                    ? 'Show their work again, and let it be fetched.'
                    : 'Stop fetching their work, and hide what is only theirs.',
                style: TextStyle(fontSize: 12.5, color: ground.inkMute),
              ),
              onTap: () async {
                final wasBlocked = blocked.contains(name);
                // taken before the sheet goes: afterwards this context is no
                // longer in the tree and has no messenger to ask
                final messenger = ScaffoldMessenger.of(context);
                final sheet = Navigator.of(context);
                await library.setBlocked(name, blocked: !wasBlocked);
                sheet.pop(true);
                messenger.showSnackBar(
                  SnackBar(
                    content: Text(
                      wasBlocked ? '$name unblocked.' : '$name blocked.',
                    ),
                    action: SnackBarAction(
                      label: 'Undo',
                      onPressed: () =>
                          library.setBlocked(name, blocked: wasBlocked),
                    ),
                  ),
                );
              },
            ),
          ],

          ListTile(
            leading: Icon(Icons.delete_outline, color: ground.accent),
            title: Text(
              'Delete from the library',
              style: TextStyle(color: ground.accent),
            ),
            subtitle: Text(
              'The text, the chapters, and where you had got to.',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
            onTap: () async {
              final sheet = Navigator.of(context);
              final sure = await _confirmDelete(context, work);
              if (!sure) return;
              await library.deleteWork(work.workId);
              sheet.pop(true);
            },
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

/// Minutes, said the way somebody would say them.
String _hours(int minutes) {
  if (minutes < 90) return '$minutes minutes';
  final hours = minutes / 60;
  return '${hours.toStringAsFixed(hours < 10 ? 1 : 0)} hours';
}

/// There is no undo for this one, so it is asked rather than assumed.
///
/// A snackbar with Undo would be a lie: the chapters are gone by then, and
/// putting them back means fetching them again from a site the reader may not
/// be able to reach.
Future<bool> _confirmDelete(BuildContext context, WorkRow work) async {
  final yes = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Delete this work?'),
      content: Text(
        '“${work.title}” and everything kept with it — the chapters, the '
        'pictures, and where you had got to — are removed from this device. '
        'It stops being fetched again, so it will not come back on its own.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Keep it'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Delete'),
        ),
      ],
    ),
  );
  return yes ?? false;
}
