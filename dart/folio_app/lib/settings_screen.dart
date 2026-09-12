import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import 'downloads.dart';
import 'library.dart';
import 'theme.dart';

/// The things that are about the library rather than about a work.
///
/// These lived in an overflow menu, which is where things go when nobody has
/// decided where they belong. Backing up in particular has no business being
/// three taps behind a caret: it is the one action that protects everything
/// else in here.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({
    required this.library,
    required this.downloads,
    required this.onImported,
    required this.onBlocked,
    required this.onActivity,
    super.key,
  });

  final Library library;
  final Downloads? downloads;
  final void Function(Library) onImported;
  final VoidCallback onBlocked;
  final VoidCallback onActivity;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _working = false;
  String? _said;
  Future<void> _backUp() async {
    setState(() {
      _working = true;
      _said = null;
    });
    try {
      /* Copied out, then handed over. A library is far too big to read into
         memory in order to save it, and a backup the app filed somewhere of
         its own choosing is one nobody can find on the day the phone is
         gone — so the reader says where it goes, and it goes off the phone.
         The copy is checkpointed first, because the database is in WAL mode
         and archive.db alone is missing the most recent reading of all. */
      final scratch = await getTemporaryDirectory();
      final copy = p.join(scratch.path, Library.backupName());
      final bytes = await widget.library.backupTo(copy);

      final result = await SharePlus.instance.share(
        ShareParams(
          files: [XFile(copy)],
          fileNameOverrides: [Library.backupName()],
          subject: 'Fan Folio library',
        ),
      );
      if (!mounted) return;
      setState(() {
        _working = false;
        _said = result.status == ShareResultStatus.dismissed
            ? null
            : '${_size(bytes)} saved. Keep it somewhere that is not this '
                  'phone.';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _working = false;
        _said = 'That did not work: $e';
      });
    }
  }

  Future<void> _bringOneIn() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Bring in a backup?'),
        content: const Text(
          'The library here is set aside rather than overwritten — being '
          'wrong about this should cost you a rename, not a library — but '
          'what you are reading now will be replaced by whatever is in the '
          'file.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Leave it'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Bring it in'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;

    setState(() {
      _working = true;
      _said = null;
    });
    try {
      // deliberately not filtered by extension: a backup arrives named all
      // sorts of things, and a picker that hides the file somebody is looking
      // straight at is worse than one that shows too much
      final picked = await FilePicker.pickFile();
      if (picked == null) {
        if (mounted) setState(() => _working = false);
        return;
      }
      final library = await Library.importFromStream(picked.readAsByteStream());
      if (!mounted) return;
      widget.onImported(library);
      Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _working = false;
        _said = 'That did not work: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        children: [
          _Heading('The library', ground: ground),
          ListTile(
            leading: Icon(Icons.save_alt, color: ground.inkMid),
            title: const Text('Back it up'),
            subtitle: Text(
              'Everything: the works, the tags, where you had got to, and '
              'how you read.',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
            enabled: !_working,
            onTap: _backUp,
          ),
          ListTile(
            leading: Icon(Icons.folder_open, color: ground.inkMid),
            title: const Text('Bring in a backup'),
            subtitle: Text(
              'From this app or from 1.x. What is here now is set aside, '
              'not deleted.',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
            enabled: !_working,
            onTap: _bringOneIn,
          ),
          if (_working)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Center(child: CircularProgressIndicator()),
            ),
          if (_said != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
              child: Text(
                _said!,
                style: TextStyle(
                  fontSize: 13,
                  height: 1.4,
                  color: ground.inkMid,
                ),
              ),
            ),

          Divider(height: 24, color: ground.lineSoft),
          _Heading('Downloading', ground: ground),
          ListTile(
            leading: Icon(Icons.sync, color: ground.inkMid),
            title: const Text('Activity'),
            subtitle: Text(
              'What is being fetched, and what it is waiting for.',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
            onTap: widget.onActivity,
          ),
          ListTile(
            leading: Icon(Icons.person_off, color: ground.inkMid),
            title: const Text('Blocked authors'),
            subtitle: Text(
              'Nothing of theirs is fetched, and what is only theirs is '
              'hidden.',
              style: TextStyle(fontSize: 12.5, color: ground.inkMute),
            ),
            onTap: widget.onBlocked,
          ),

          Divider(height: 24, color: ground.lineSoft),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 28),
            child: Text(
              'The library lives on this phone and nowhere else. Nothing here '
              'is uploaded, and nothing is kept about you anywhere but here — '
              'which is also why a backup is worth making.',
              style: TextStyle(
                fontSize: 12.5,
                height: 1.5,
                color: ground.inkFaint,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// A size somebody can judge at a glance, which is the only reason to show it.
String _size(int bytes) {
  if (bytes >= 1 << 30) return '${(bytes / (1 << 30)).toStringAsFixed(1)} GB';
  if (bytes >= 1 << 20) return '${(bytes / (1 << 20)).toStringAsFixed(0)} MB';
  return '${(bytes / 1024).toStringAsFixed(0)} KB';
}

class _Heading extends StatelessWidget {
  const _Heading(this.text, {required this.ground});

  final String text;
  final Ground ground;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 18, 16, 6),
    child: Text(
      text.toUpperCase(),
      style: TextStyle(
        fontSize: 11,
        letterSpacing: 0.9,
        fontWeight: FontWeight.w600,
        color: ground.inkFaint,
      ),
    ),
  );
}
