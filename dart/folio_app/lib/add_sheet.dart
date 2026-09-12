import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'downloads.dart';
import 'theme.dart';

/// Adding a work by its link.
///
/// The smallest possible way in, and the one worth having first: somebody sees
/// a fic somewhere, copies the address, and wants it on their shelf. The
/// clipboard is offered rather than waited for, because that is where the link
/// almost always already is.
Future<bool> showAddByLink(BuildContext context, Downloads downloads) async {
  final added = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: _AddByLink(downloads: downloads),
    ),
  );
  return added ?? false;
}

class _AddByLink extends StatefulWidget {
  const _AddByLink({required this.downloads});

  final Downloads downloads;

  @override
  State<_AddByLink> createState() => _AddByLinkState();
}

class _AddByLinkState extends State<_AddByLink> {
  final TextEditingController _box = TextEditingController();
  String? _trouble;

  @override
  void initState() {
    super.initState();
    _offerTheClipboard();
  }

  @override
  void dispose() {
    _box.dispose();
    super.dispose();
  }

  Future<void> _offerTheClipboard() async {
    try {
      final held = await Clipboard.getData(Clipboard.kTextPlain);
      final text = held?.text?.trim() ?? '';
      if (!mounted || text.isEmpty || !text.contains('archiveofourown')) return;
      // filled in, not submitted: it is still the reader's decision
      _box.text = text;
    } catch (_) {
      // a clipboard that will not be read is not a reason to fail the sheet
    }
  }

  Future<void> _add() async {
    final sheet = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await widget.downloads.addByLink(_box.text);
      sheet.pop(true);
      messenger.showSnackBar(
        const SnackBar(content: Text('Queued. It will appear when it lands.')),
      );
    } on FormatException catch (e) {
      setState(() => _trouble = e.message);
    } catch (e) {
      setState(() => _trouble = '$e');
    }
  }

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);

    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Add a work',
              style: TextStyle(
                fontFamily: titleFace,
                fontSize: 19,
                fontWeight: FontWeight.w600,
                color: ground.ink,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'A link to the work, a chapter of it, or just its number.',
              style: TextStyle(fontSize: 13, color: ground.inkMute),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: _box,
              autofocus: true,
              keyboardType: TextInputType.url,
              textInputAction: TextInputAction.go,
              onSubmitted: (_) => _add(),
              decoration: InputDecoration(
                hintText: 'https://archiveofourown.org/works/…',
                errorText: _trouble,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(Radii.field),
                ),
              ),
            ),
            const SizedBox(height: 14),
            FilledButton(onPressed: _add, child: const Text('Add it')),
            const SizedBox(height: 6),
            Text(
              'It is fetched at a reader’s pace rather than a '
              'scraper’s, so give it a moment. Activity shows where it '
              'has got to.',
              style: TextStyle(
                fontSize: 12,
                height: 1.4,
                color: ground.inkFaint,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
