import 'package:flutter/material.dart';
import 'package:folio_core/folio_core.dart' as core;

import 'downloads.dart';
import 'theme.dart';

/// What the app is doing, and what it is waiting for.
///
/// An hour of downloading that happens silently is indistinguishable from an
/// hour of nothing happening, and the reader has no way to tell whether to
/// keep the app open. So the queue is visible, and pausable, and says why it
/// is waiting when it is waiting rather than working.
class ActivityScreen extends StatelessWidget {
  const ActivityScreen({required this.downloads, super.key});

  final Downloads downloads;

  @override
  Widget build(BuildContext context) {
    final ground = groundOf(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Activity')),
      body: ListenableBuilder(
        listenable: downloads,
        builder: (context, _) {
          final jobs = downloads.jobs;
          final cooling = downloads.cooling;

          return ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              if (cooling != null) _Cooling(until: cooling, ground: ground),
              if (jobs.isEmpty)
                Padding(
                  padding: const EdgeInsets.all(32),
                  child: Text(
                    'Nothing in the queue.\n\nWorks added by link appear here '
                    'while they are being fetched.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: ground.inkMute, height: 1.5),
                  ),
                ),
              for (final job in jobs)
                _JobTile(job: job, downloads: downloads, ground: ground),
            ],
          );
        },
      ),
    );
  }
}

/// The archive asked for room, and everything waits — not only whoever was
/// told. Saying so is the difference between a queue that looks stuck and one
/// that is being polite.
class _Cooling extends StatelessWidget {
  const _Cooling({required this.until, required this.ground});

  final DateTime until;
  final Ground ground;

  @override
  Widget build(BuildContext context) {
    final left = until.difference(DateTime.now());
    final minutes = left.inMinutes;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 14, 16, 4),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: ground.sunken,
        borderRadius: BorderRadius.circular(Radii.card),
      ),
      child: Row(
        children: [
          Icon(Icons.hourglass_bottom, size: 20, color: ground.inkMute),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              minutes < 1
                  ? 'The archive asked for a moment. Carrying on shortly.'
                  : 'The archive asked to be left alone for about '
                        '$minutes ${minutes == 1 ? 'minute' : 'minutes'}. '
                        'Going back sooner earns a longer wait, not a faster '
                        'download.',
              style: TextStyle(
                fontSize: 13,
                height: 1.45,
                color: ground.inkMid,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _JobTile extends StatelessWidget {
  const _JobTile({
    required this.job,
    required this.downloads,
    required this.ground,
  });

  final core.JobView job;
  final Downloads downloads;
  final Ground ground;

  /// A line about where this has got to.
  ///
  /// A job reading an index has no works to count yet, and "0 of 0" is what
  /// that looked like from the outside — so a walk says which page it is on
  /// and a download says how many works.
  String get _where {
    if (job.state == core.JobState.listing) {
      return job.pages == null
          ? 'Reading the list, page ${job.page}'
          : 'Reading the list, page ${job.page} of ${job.pages}';
    }
    final of = job.open ? '${job.total} so far' : '${job.total}';
    return '${job.done} of $of';
  }

  String get _state => switch (job.state) {
    core.JobState.listing => 'Listing',
    core.JobState.queued => 'Waiting',
    core.JobState.running => 'Downloading',
    core.JobState.pausing => 'Pausing',
    core.JobState.paused => 'Paused',
    // a job that was stopped after saying what went wrong was not stopped by
    // anybody; it gave up, and the line under it says why
    core.JobState.cancelled => job.say == null ? 'Stopped' : 'Gave up',
    core.JobState.done => job.unfinished > 0 ? 'Finished, partly' : 'Finished',
  };

  @override
  Widget build(BuildContext context) {
    final running = job.state == core.JobState.running;
    final over =
        job.state == core.JobState.done || job.state == core.JobState.cancelled;

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 10, 16, 0),
      padding: const EdgeInsets.fromLTRB(14, 12, 8, 10),
      decoration: BoxDecoration(
        color: ground.surface,
        borderRadius: BorderRadius.circular(Radii.card),
        border: Border.all(color: ground.lineSoft),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  job.author,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: titleFace,
                    fontSize: 15.5,
                    fontWeight: FontWeight.w600,
                    color: ground.ink,
                  ),
                ),
              ),
              Text(
                _state,
                style: TextStyle(fontSize: 12, color: ground.inkMute),
              ),
              _Buttons(job: job, downloads: downloads, over: over),
            ],
          ),
          Text(_where, style: TextStyle(fontSize: 12.5, color: ground.inkMute)),
          if (job.say != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                job.say!,
                style: TextStyle(fontSize: 12.5, color: ground.inkMid),
              ),
            ),
          /* Why it stopped, in the words it stopped with. A queue that says
             "1 failed" and nothing else leaves the reader with nothing to do
             about it. */
          if (job.lastError != null && job.state != core.JobState.running)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                job.lastError!,
                style: TextStyle(fontSize: 12.5, color: ground.accent),
              ),
            ),
          if (job.retrying != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Trying again: ${job.retrying}',
                style: TextStyle(fontSize: 12.5, color: ground.inkMute),
              ),
            ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(Radii.pill),
            child: LinearProgressIndicator(
              // an open list has no denominator worth trusting yet, and a bar
              // that slides backwards is worse than one that does not claim
              value: job.open || job.total == 0
                  ? null
                  : (job.done / job.total).clamp(0, 1),
              minHeight: 4,
              backgroundColor: ground.sunken,
              color: running ? ground.accent : ground.line,
            ),
          ),
        ],
      ),
    );
  }
}

class _Buttons extends StatelessWidget {
  const _Buttons({
    required this.job,
    required this.downloads,
    required this.over,
  });

  final core.JobView job;
  final Downloads downloads;
  final bool over;

  @override
  Widget build(BuildContext context) {
    if (over) {
      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (job.unfinished > 0)
            IconButton(
              icon: const Icon(Icons.refresh),
              tooltip: 'Try the rest again',
              onPressed: () => downloads.rerun(job.id),
            ),
          IconButton(
            icon: const Icon(Icons.close),
            tooltip: 'Clear',
            onPressed: () => downloads.remove(job.id),
          ),
        ],
      );
    }

    final paused =
        job.state == core.JobState.paused || job.state == core.JobState.pausing;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          icon: Icon(paused ? Icons.play_arrow : Icons.pause),
          tooltip: paused ? 'Carry on' : 'Pause',
          onPressed: () =>
              paused ? downloads.resume(job.id) : downloads.pause(job.id),
        ),
        IconButton(
          icon: const Icon(Icons.stop),
          tooltip: 'Stop',
          onPressed: () => downloads.stop(job.id),
        ),
      ],
    );
  }
}
