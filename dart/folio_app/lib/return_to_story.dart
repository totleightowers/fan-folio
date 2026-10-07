import 'package:flutter/material.dart';

import 'library.dart';
import 'theme.dart';

/// The whole pill is one accessible target; it never competes with the reader.
class ReturnToStory extends StatelessWidget {
  const ReturnToStory({
    required this.work,
    required this.chapter,
    required this.onResume,
    super.key,
  });
  final WorkRow work;
  final int chapter;
  final VoidCallback onResume;

  @override
  Widget build(BuildContext context) => SafeArea(
    top: false,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Material(
        color: groundOf(context).surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(24),
          side: BorderSide(color: groundOf(context).line),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onResume,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                const Icon(Icons.bookmark_outline),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        'Return to the story · Chapter $chapter',
                        style: Theme.of(context).textTheme.labelSmall,
                      ),
                      Text(
                        work.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.play_arrow_outlined),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
