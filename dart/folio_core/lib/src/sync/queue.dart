/// Work the app owes the archive, done in the open.
///
/// Fetching an author's catalogue is hundreds of requests over an hour. That
/// is a reasonable thing to spend and an unreasonable thing to spend
/// invisibly: an app quietly busy for an hour, saying nothing, is
/// indistinguishable from one that is broken. So the queue is a thing the
/// reader can see, reorder, pause and abandon.
///
/// Ported from app/core/sync/queue.js. Nearly every rule in here was a fault
/// once, and the comments say which — a rewrite that tidied them away would
/// find all of them again, on somebody's phone, over an hour.
library;

import 'dart:async';

enum JobState { listing, queued, running, pausing, paused, cancelled, done }

/// What a job looks like from outside it.
class JobView {
  const JobView({
    required this.id,
    required this.author,
    required this.part,
    required this.state,
    required this.total,
    required this.done,
    required this.added,
    required this.failed,
    required this.open,
    required this.unfinished,
    required this.rounds,
    required this.page,
    required this.pages,
    required this.parallel,
    this.at,
    this.retrying,
    this.lastError,
    this.say,
  });

  final int id;
  final String author;
  final String part;
  final JobState state;

  /// How many it was ever about. A running job knows from its own list; a
  /// finished one has emptied that list, so it has to have been kept — which
  /// it was not, and every restored record read 0 of 0 and then saved those
  /// zeros back over what it had actually done.
  final int total;
  final int done;
  final int added;
  final int failed;

  /// The list is still being read, so [total] is what is known so far rather
  /// than what there will be — the difference between a bar that can be
  /// trusted and one that slides backwards.
  final bool open;

  /// Work that ran out of retries rather than being refused, or that the
  /// database says never arrived: still owed either way.
  final int unfinished;
  final int rounds;

  /// Where a walk has got to. A job reading an index has no works to count
  /// yet, and a bookmark reconciliation never has any at all — "0 of 0" is
  /// what that looked like from the outside.
  final int page;
  final int? pages;
  final bool parallel;
  final DateTime? at;
  final String? retrying;
  final String? lastError;

  /// A line the job has written about itself, for work whose outcome is not a
  /// number of downloads: how many bookmarks were read, what changed.
  final String? say;
}

class _Job {
  _Job({
    required this.id,
    required this.author,
    required this.part,
    required this.workIds,
    required this.open,
    this.at,
    this.wasTotal = 0,
  });

  final int id;
  final String author;
  final String part;
  List<String> workIds;
  bool open;

  JobState state = JobState.queued;
  int done = 0;
  int added = 0;
  int failed = 0;
  int attempt = 0;
  int rounds = 0;
  int page = 0;
  int? pages;
  int wasTotal;
  bool parallel = false;
  List<String> unfinished = [];
  DateTime? at;
  String? retrying;
  String? lastError;
  String? say;

  JobView get view => JobView(
        id: id,
        author: author,
        part: part,
        state: state,
        total: workIds.isNotEmpty ? workIds.length : wasTotal,
        done: done,
        added: added,
        failed: failed,
        open: open,
        unfinished: unfinished.length,
        rounds: rounds,
        page: page,
        pages: pages,
        parallel: parallel,
        at: at,
        retrying: retrying,
        lastError: lastError,
        say: say,
      );
}

/// A job as it is written down, so a restart resumes rather than starting over.
class SavedJob {
  const SavedJob({
    required this.author,
    required this.part,
    required this.state,
    required this.workIds,
    required this.unfinished,
    required this.total,
    required this.added,
    required this.failed,
    required this.open,
    required this.page,
    required this.pages,
    required this.rounds,
    this.lastError,
    this.say,
    this.at,
  });

  factory SavedJob.fromJson(Map<String, Object?> j) => SavedJob(
        author: '${j['author']}',
        part: '${j['part']}',
        state: JobState.values.firstWhere(
          (s) => s.name == j['state'],
          orElse: () => JobState.queued,
        ),
        workIds:
            ((j['workIds'] as List?) ?? const []).map((v) => '$v').toList(),
        unfinished:
            ((j['unfinished'] as List?) ?? const []).map((v) => '$v').toList(),
        total: (j['total'] as num?)?.toInt() ?? 0,
        added: (j['added'] as num?)?.toInt() ?? 0,
        failed: (j['failed'] as num?)?.toInt() ?? 0,
        open: j['open'] == true,
        page: (j['page'] as num?)?.toInt() ?? 0,
        pages: (j['pages'] as num?)?.toInt(),
        rounds: (j['rounds'] as num?)?.toInt() ?? 0,
        lastError: j['lastError'] as String?,
        say: j['say'] as String?,
        at: j['at'] == null
            ? null
            : DateTime.fromMillisecondsSinceEpoch((j['at'] as num).toInt()),
      );

  final String author;
  final String part;
  final JobState state;
  final List<String> workIds;
  final List<String> unfinished;
  final int total;
  final int added;
  final int failed;
  final bool open;
  final int page;
  final int? pages;
  final int rounds;
  final String? lastError;
  final String? say;
  final DateTime? at;

  Map<String, Object?> toJson() => {
        'author': author,
        'part': part,
        'state': state.name,
        'workIds': workIds,
        'unfinished': unfinished,
        'total': total,
        'added': added,
        'failed': failed,
        'open': open,
        'page': page,
        'pages': pages,
        'rounds': rounds,
        'lastError': lastError,
        'say': say,
        'at': at?.millisecondsSinceEpoch,
      };
}

/// The queue.
///
/// One job runs at a time by default, because two would double the rate at the
/// archive without either knowing. A job can be told to start now anyway — it
/// then runs alongside whatever is already going, which is worse manners and
/// the reader's call to make.
class JobQueue {
  JobQueue({
    required this.runTask,
    required this.wait,
    this.onEvent,

    /// A deleted work is deleted next time too. A 500 is the archive having a
    /// bad moment, and giving up on it writes off something that was probably
    /// fine a minute later — so one is retried and the other is not.
    bool Function(String?)? shouldRetry,
    Duration Function(int)? retryWait,
    this.maxRetries = 3,

    /// Which of these the database still does not hold.
    ///
    /// A job used to decide it had finished by counting: the task did not
    /// throw, so the work arrived. Those are different statements — a fetch
    /// can end having stored a description and no text — so jobs reported
    /// themselves complete while the works they had queued were still stubs.
    Future<List<String>> Function(List<String>)? verify,
    this.maxRounds = 3,
  })  : shouldRetry = shouldRetry ?? ((_) => false),
        retryWait =
            retryWait ?? ((attempt) => Duration(seconds: 28 * (attempt + 1))),
        verify = verify ?? ((_) async => const []);

  final Future<void> Function(String workId) runTask;
  final Future<void> Function(Duration) wait;
  final void Function(String type, JobView? job, List<JobView> jobs)? onEvent;
  final bool Function(String?) shouldRetry;
  final Duration Function(int) retryWait;
  final int maxRetries;
  final Future<List<String>> Function(List<String>) verify;
  final int maxRounds;

  final List<_Job> _jobs = [];
  int _nextId = 1;

  List<JobView> list() => _jobs.map((j) => j.view).toList();

  _Job? _find(int id) {
    for (final job in _jobs) {
      if (job.id == id) return job;
    }
    return null;
  }

  void _announce(String type, [_Job? job]) =>
      onEvent?.call(type, job?.view, list());

  /// Add work, or give it to the job already doing that job.
  ///
  /// Opening an author twice should not start a second download of the same
  /// catalogue. A job for the same author and the same half is the same job.
  int add({
    required String author,
    required String part,
    List<String> workIds = const [],
    bool open = false,
  }) {
    for (final existing in _jobs) {
      if (existing.author == author &&
          existing.part == part &&
          existing.state != JobState.done &&
          existing.state != JobState.cancelled) {
        if (open) existing.open = true;
        append(existing.id, workIds);
        return existing.id;
      }
    }

    final job = _Job(
      id: _nextId++,
      author: author,
      part: part,
      workIds: [...workIds],
      open: open,
      at: DateTime.now(),
    )..state = open && workIds.isEmpty ? JobState.listing : JobState.queued;
    _jobs.add(job);
    _announce('queued', job);
    _pump();
    return job.id;
  }

  /// Add more work to a job already going.
  ///
  /// A listing is walked a page at a time with a pause between, so waiting for
  /// the whole walk before queueing anything means a minute or two of an app
  /// that looks like it did nothing. The first page is queued the moment it
  /// lands and the rest arrives as it is read.
  bool append(int id, List<String> workIds) {
    final job = _find(id);
    if (job == null ||
        job.state == JobState.done ||
        job.state == JobState.cancelled) {
      return false;
    }
    final known = job.workIds.toSet();
    final fresh = workIds.where((w) => !known.contains(w)).toList();
    if (fresh.isEmpty) return false;
    job.workIds.addAll(fresh);
    // it has something to do now
    if (job.state == JobState.listing) job.state = JobState.queued;
    _announce('grew', job);
    _pump();
    return true;
  }

  bool pause(int id) {
    final job = _find(id);
    if (job == null ||
        job.state == JobState.done ||
        job.state == JobState.cancelled) {
      return false;
    }
    /* A running job stops after the work in flight; anything else — waiting
       its turn, or still reading an index — simply waits. A job reading an
       index is doing the most network of all, so it is the last thing that
       should be exempt from Pause. */
    job.state =
        job.state == JobState.running ? JobState.pausing : JobState.paused;
    _announce('paused', job);
    return true;
  }

  bool resume(int id) {
    final job = _find(id);
    if (job == null ||
        (job.state != JobState.paused && job.state != JobState.pausing)) {
      return false;
    }
    job.state = JobState.queued;
    _announce('resumed', job);
    _pump();
    return true;
  }

  /// End it, but leave it on the list so the reader sees what happened.
  bool stop(int id) {
    final job = _find(id);
    if (job == null || job.state == JobState.done) return false;
    job.state = JobState.cancelled;
    _announce('stopped', job);
    _pump();
    return true;
  }

  /// Off the list entirely.
  bool remove(int id) {
    final job = _find(id);
    if (job == null) return false;
    _jobs.remove(job);
    job.state = JobState.cancelled; // a runner mid-flight notices and stops
    _announce('removed', job);
    _pump();
    return true;
  }

  /// Run this one now, alongside whatever is already running.
  ///
  /// Deliberately not a preemption: abandoning a job halfway through an author
  /// to serve an impatient tap wastes what it had already done. Two at once
  /// asks the archive for twice as much, which it may refuse — the reader is
  /// spending their own account's goodwill and has said so by pressing this.
  bool startNow(int id) {
    final job = _find(id);
    if (job == null ||
        job.state == JobState.done ||
        job.state == JobState.cancelled) {
      return false;
    }
    job.parallel = true;
    if (job.state == JobState.paused || job.state == JobState.pausing) {
      job.state = JobState.queued;
    }
    _announce('rushed', job);
    _pump();
    return true;
  }

  bool moveUp(int id) => _swap(id, -1);
  bool moveDown(int id) => _swap(id, 1);

  bool _swap(int id, int delta) {
    final at = _jobs.indexWhere((j) => j.id == id);
    final to = at + delta;
    if (at == -1 || to < 0 || to >= _jobs.length) return false;
    final job = _jobs.removeAt(at);
    _jobs.insert(to, job);
    _announce('reordered', job);
    return true;
  }

  /// The walk reporting where it has got to, so a restart can pick it up —
  /// and, for work that does not end in downloads, what it came to.
  bool note(int id, {int? page, int? pages, String? say}) {
    final job = _find(id);
    if (job == null) return false;
    if (page != null) job.page = page;
    if (pages != null) job.pages = pages;
    if (say != null) job.say = say;
    _announce('noted', job);
    return true;
  }

  /// The list is complete: whatever is in the job now is all of it.
  ///
  /// Called when a walk ends, however it ended. A job left open by a walk that
  /// failed would sit saying it was still reading for ever.
  bool seal(int id) {
    final job = _find(id);
    if (job == null) return false;
    job.open = false;
    if (job.state == JobState.listing) {
      job.state =
          job.done >= job.workIds.length ? JobState.done : JobState.queued;
      _announce(job.state == JobState.done ? 'finished' : 'sealed', job);
      _pump();
    }
    return true;
  }

  /// May this job make another request, and if not yet, wait until it may.
  ///
  /// A job is one thing to the person who started it — reading an index and
  /// fetching what it names — and it was two machines to the app: the queue,
  /// which honoured Pause, and the listing walk, which had never heard of it.
  /// So Pause stopped the downloading and left the walk asking the archive for
  /// page after page. Every long loop asks this before its next turn.
  ///
  /// Returns false when there is nothing left to run for: stopped, or gone.
  Future<bool> waitUntilRunnable(int id) async {
    for (;;) {
      final job = _find(id);
      if (job == null || job.state == JobState.cancelled) return false;
      if (job.state != JobState.paused && job.state != JobState.pausing) {
        return true;
      }
      /* A floor, so this cannot become a spin if the gap is ever nothing. It
         is asking how long somebody has left it paused, which is not a
         question worth asking many times a second. */
      await wait(const Duration(seconds: 1));
    }
  }

  /// Whether this job has been stopped or removed out from under a loop.
  bool isStopped(int id) {
    final job = _find(id);
    return job == null || job.state == JobState.cancelled;
  }

  void _pump() {
    // the ordinary lane: one job, in order
    final ordinary = _jobs.any(
      (j) => j.state == JobState.running && !j.parallel,
    );
    if (!ordinary) {
      for (final job in _jobs) {
        if (job.state == JobState.queued && !job.parallel) {
          unawaited(_drive(job));
          break;
        }
      }
    }
    // and anything the reader has told to go now, whatever else is happening
    for (final job in [..._jobs]) {
      if (job.state == JobState.queued && job.parallel) unawaited(_drive(job));
    }
  }

  Future<void> _drive(_Job job) async {
    if (job.state == JobState.running) return;
    job.state = JobState.running;
    _announce('started', job);

    while (job.done < job.workIds.length) {
      if (job.state != JobState.running) break; // paused, stopped or removed
      /* Waiting before the request rather than after the last one, so a job
         that is abandoned does not leave the next one holding its debt. */
      if (job.done > 0) await wait(Duration.zero);
      if (job.state != JobState.running) break;

      try {
        await runTask(job.workIds[job.done]);
        job.added += 1;
        job.attempt = 0;
      } catch (e) {
        final attempt = job.attempt;
        if (shouldRetry('$e') && attempt < maxRetries) {
          /* Left where it is and tried again, longer each time. It is not
             finished with, so it does not count as done and does not count
             against the work. */
          job.attempt = attempt + 1;
          job.retrying = '$e';
          _announce('retrying', job);
          await wait(retryWait(attempt));
          continue;
        }
        /*
         * A bookmark outlives the work it points at, so a failure is noted and
         * the job carries on. But there are two kinds of failure here and only
         * one is final: a work that is gone is gone, while one that ran out of
         * retries during an outage is unfinished business. Keeping the second
         * means a restart picks it up instead of the job reporting nothing
         * downloaded and vanishing.
         */
        job.failed += 1;
        job.lastError = '$e';
        if (shouldRetry('$e')) job.unfinished.add(job.workIds[job.done]);
        job.attempt = 0;
        job.retrying = null;
      }
      job.done += 1;
      job.retrying = null;
      _announce('progress', job);
    }

    if (job.state == JobState.pausing) {
      job.state = JobState.paused;
      _announce('finished', job);
      _pump();
      return;
    }
    if (job.state != JobState.running) {
      _announce('finished', job);
      _pump();
      return;
    }

    /* Out of work but not out of list: back to waiting rather than reporting
       itself finished, and the next page to land wakes it. */
    if (job.open) {
      job.state = JobState.listing;
      _announce('waiting', job);
      _pump();
      return;
    }

    /*
     * Having counted to the end is not the same as having got everything. Ask
     * what is still missing and go round again for those — a bounded number of
     * times, because a work the archive will not give up is not a reason to
     * ask for ever.
     */
    job.rounds += 1;
    var owed = <String>[];
    try {
      owed = await verify(job.workIds);
    } catch (_) {
      owed = [];
    }

    if (owed.isNotEmpty && job.rounds < maxRounds) {
      job.workIds = owed;
      job.done = 0;
      job.unfinished = [];
      job.state = JobState.queued;
      _announce('again', job);
      _pump();
      return;
    }

    /* Out of rounds with work still missing: owed, not delivered, so it is
       kept and saved rather than quietly counted as done. */
    if (owed.isNotEmpty) job.unfinished = owed;
    job.state = JobState.done;
    _announce('finished', job);
    _pump();
  }

  /// Do it again: what a finished job could not get, or the whole list if it
  /// got everything. A job that reported itself done while leaving works
  /// behind was the thing there was no way to act on.
  bool rerun(int id) {
    final job = _find(id);
    if (job == null) return false;
    final again = job.unfinished.isNotEmpty ? job.unfinished : job.workIds;
    if (again.isEmpty) return false;
    job.workIds = [...again];
    job.done = 0;
    job.added = 0;
    job.failed = 0;
    job.unfinished = [];
    job.rounds = 0;
    job.lastError = null;
    job.attempt = 0;
    job.state = JobState.queued;
    _announce('again', job);
    _pump();
    return true;
  }

  /// Put a saved job back on the list without running it.
  ///
  /// What came back from a restart used to be only the work still owed, so a
  /// job that had finished came back as nothing at all. This restores the
  /// record — what was asked for and how it went — and only the ones with work
  /// left are handed to the runner.
  int restore(SavedJob saved) {
    final owed = [...saved.workIds];
    final job = _Job(
      id: _nextId++,
      author: saved.author,
      part: saved.part,
      workIds: owed,
      open: saved.open,
      at: saved.at,
      // what it was ever about, kept as a number rather than worked out from a
      // list it may have finished with
      wasTotal: saved.total != 0 ? saved.total : owed.length,
    )
      ..added = saved.added
      ..failed = saved.failed
      ..page = saved.page
      ..pages = saved.pages
      ..rounds = saved.rounds
      ..lastError = saved.lastError
      ..say = saved.say
      ..unfinished = saved.state == JobState.done ? [...saved.unfinished] : []
      ..state = saved.state == JobState.done ? JobState.done : JobState.queued;

    /* Anything owed by a job that had not finished goes back to waiting; a
       finished one stays finished, with what it never got still named. */
    if (job.state != JobState.done && job.workIds.isEmpty) {
      job.state = job.open ? JobState.listing : JobState.done;
    }
    _jobs.add(job);
    _announce('restored', job);
    if (job.state == JobState.queued) _pump();
    return job.id;
  }

  /// The jobs themselves, not a summary of them.
  ///
  /// This used to hand back a description — what was left, how it went — and
  /// the other side built a job out of that description. Every round trip
  /// through those two lost something: first the totals, then the times, then
  /// the work still owed. The cure is not a better description; it is to write
  /// down the job and read the job back.
  ///
  /// A finished job keeps its counts and whatever it never got, and lets go of
  /// the ids it delivered — those are in the library now, and thousands of
  /// them are not worth carrying around to say a job went well.
  ///
  /// Bounded to the last forty: a record of recent work, not a log.
  List<SavedJob> save() {
    final keep = _jobs.where((j) => j.state != JobState.cancelled).toList();
    final recent = keep.length > 40 ? keep.sublist(keep.length - 40) : keep;
    return recent.map((j) {
      final settled = j.state == JobState.done;
      return SavedJob(
        author: j.author,
        part: j.part,
        state: j.state,
        workIds: settled
            ? [...j.unfinished]
            : [...j.workIds.skip(j.done), ...j.unfinished],
        unfinished: [...j.unfinished],
        total: j.workIds.isNotEmpty ? j.workIds.length : j.wasTotal,
        added: j.added,
        failed: j.failed,
        open: j.open,
        page: j.page,
        pages: j.pages,
        rounds: j.rounds,
        lastError: j.lastError,
        say: j.say,
        at: j.at,
      );
    }).toList();
  }
}
