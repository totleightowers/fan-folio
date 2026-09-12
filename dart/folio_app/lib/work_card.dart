import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'library.dart';
import 'theme.dart';

/// A work on a shelf.
///
/// Fic has no covers, so a shelf is otherwise a shelf of text and finding
/// something by eye means reading every title on it. Each card carries a
/// coloured spine derived from its fandom, and the same fandom is the same
/// colour wherever it appears — so a row of cards becomes scannable rather
/// than merely listed.
class WorkCard extends StatelessWidget {
  const WorkCard({
    required this.work,
    required this.onTap,
    this.onLongPress,
    super.key,
  });

  final WorkRow work;
  final VoidCallback onTap;

  /// Holding a work is how you get at what you can do to it. A shelf of cards
  /// has no room for a menu button on each, and a long press is what a phone
  /// has always meant by "this one, and something other than opening it".
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final spine = Color(0xFF000000 | core.spineRgb(work.fandom ?? work.title));

    return SizedBox(
      width: 200,
      child: Material(
        color: ground.surface,
        borderRadius: BorderRadius.circular(Radii.card),
        child: InkWell(
          onTap: onTap,
          onLongPress: onLongPress,
          borderRadius: BorderRadius.circular(Radii.card),
          child: Ink(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(Radii.card),
              border: Border.all(color: ground.lineSoft),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // the spine: four pixels of colour doing the work a cover does
                Container(width: 4, color: spine),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(11, 11, 11, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          work.title,
                          maxLines: 3,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontFamily: titleFace,
                            fontSize: 14.5,
                            fontWeight: FontWeight.w600,
                            height: 1.3,
                            color: ground.ink,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          work.byline,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: ground.inkMute),
                        ),
                        if (work.summary?.isNotEmpty ?? false) ...[
                          const SizedBox(height: 6),
                          Expanded(
                            child: Text(
                              work.summary!,
                              maxLines: 4,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 12.5,
                                height: 1.4,
                                color: ground.inkMid,
                              ),
                            ),
                          ),
                        ] else
                          const Spacer(),
                        const SizedBox(height: 6),
                        Text(
                          work.facts,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 11,
                            color: ground.inkFaint,
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A work in a list, where there is width for the summary to breathe.
class WorkRowTile extends StatelessWidget {
  const WorkRowTile({
    required this.work,
    required this.onTap,
    this.onLongPress,
    this.onPerson,
    super.key,
  });

  final WorkRow work;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  /// A byline is a way through the library, not a fact about one work.
  final void Function(String byline)? onPerson;

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    final spine = Color(0xFF000000 | core.spineRgb(work.fandom ?? work.title));

    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 13, 16, 14),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 3,
              height: 44,
              margin: const EdgeInsets.only(right: 12, top: 3),
              decoration: BoxDecoration(
                color: spine,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // The title leads. Everything under it is support, and is
                  // weighted and coloured to say so.
                  Text(
                    work.title,
                    style: TextStyle(
                      fontFamily: titleFace,
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                      height: 1.3,
                      color: ground.ink,
                    ),
                  ),
                  const SizedBox(height: 2),
                  if (onPerson == null || work.authors.isEmpty)
                    Text(
                      work.byline,
                      style: TextStyle(fontSize: 13.5, color: ground.inkMute),
                    )
                  else
                    Wrap(
                      spacing: 6,
                      children: [
                        for (final name in work.authors)
                          InkWell(
                            onTap: () => onPerson!(name),
                            child: Text(
                              name,
                              style: TextStyle(
                                fontSize: 13.5,
                                color: ground.accent,
                              ),
                            ),
                          ),
                      ],
                    ),
                  if (work.summary?.isNotEmpty ?? false) ...[
                    const SizedBox(height: 6),
                    Text(
                      work.summary!,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        height: 1.45,
                        color: ground.inkMid,
                      ),
                    ),
                  ],
                  const SizedBox(height: 7),
                  Text(
                    work.facts,
                    style: TextStyle(
                      fontSize: 12,
                      color: ground.inkFaint,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A shelf: a heading, how much of it is not on it, and a rail of cards.
class Shelf extends StatelessWidget {
  const Shelf({
    required this.title,
    required this.works,
    required this.total,
    required this.onOpen,
    this.onHold,
    this.onSeeAll,
    super.key,
  });

  final String title;
  final List<WorkRow> works;
  final int total;
  final void Function(WorkRow) onOpen;
  final void Function(WorkRow)? onHold;
  final VoidCallback? onSeeAll;

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);
    // Twelve at most, and saying nothing about it makes the missing ones read
    // as lost rather than folded away.
    final more = total > works.length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 18, 12, 9),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              // a sign, not a headline competing with the titles below it
              Text(
                title.toUpperCase(),
                style: TextStyle(
                  fontSize: 11.5,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.9,
                  color: ground.inkMute,
                ),
              ),
              if (more) ...[
                const SizedBox(width: 7),
                Text(
                  '· $total',
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w700,
                    color: ground.inkFaint,
                  ),
                ),
              ],
              const Spacer(),
              if (onSeeAll != null)
                TextButton(
                  onPressed: onSeeAll,
                  child: Text(more ? 'See all $total' : 'See all'),
                ),
            ],
          ),
        ),
        SizedBox(
          height: 176,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            itemCount: works.length,
            separatorBuilder: (_, __) => const SizedBox(width: 10),
            itemBuilder: (context, i) => WorkCard(
              work: works[i],
              onTap: () => onOpen(works[i]),
              onLongPress: onHold == null ? null : () => onHold!(works[i]),
            ),
          ),
        ),
      ],
    );
  }
}
