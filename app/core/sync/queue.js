/**
 * Work the app owes the archive, done in the open.
 *
 * Fetching an author's catalogue is hundreds of requests over an hour. That is
 * a reasonable thing to spend and an unreasonable thing to spend invisibly: an
 * app quietly busy for an hour, saying nothing, is indistinguishable from one
 * that is broken. So the queue is a thing the reader can see, reorder, pause
 * and abandon.
 *
 * One job runs at a time by default, because two would double the rate at the
 * archive without either knowing. A job can be told to start now anyway — it
 * then runs alongside whatever is already going, which is worse manners and
 * the reader's call to make.
 */

let nextId = 1;

/*
 * `listing` is a job that exists before its work does.
 *
 * Reading an author's index takes two paced requests before the first work is
 * even named, and a queue that shows nothing until then is a queue that looks
 * broken at exactly the moment somebody is watching it to see whether their
 * tap did anything. A job is put up the instant it is asked for and stays in
 * `listing` until the walk tells it what is in it.
 */
export const STATES = ['listing', 'queued', 'running', 'paused', 'cancelled', 'done'];

export function createQueue({
  runTask,
  wait,
  gap,
  onEvent = () => {},
  /* A deleted work is deleted next time too. A 500 is the archive having a bad
     moment, and giving up on it writes off something that was probably fine a
     minute later — so one is retried and the other is not. */
  shouldRetry = () => false,
  retryWait = (attempt) => gap() * (attempt + 1),
  maxRetries = 3,
  /**
   * Which of these the database still does not hold.
   *
   * A job used to decide it had finished by counting: the task did not throw,
   * so the work arrived. Those are different statements — a fetch can end
   * having stored a description and no text — so jobs reported themselves
   * complete while the works they had queued were still stubs. Asked at the
   * end of a run, and whatever it names is still owed.
   */
  verify = async () => [],
  maxRounds = 3,
} = {}) {
  const jobs = [];
  const initialItems = (ids) => new Map(ids.map(id => [String(id), { workId: String(id), state: 'waiting' }]));
  const itemChange = (job, workId, patch) => {
    const id = String(workId);
    job.items.set(id, { ...(job.items.get(id) ?? { workId: id }), ...patch });
  };

  const counts = (j) => {
    const items = [...j.items.values()];
    const added = items.filter(i => ['downloaded', 'version'].includes(i.state)).length + (j.legacyAdded || 0);
    const failed = items.filter(i => i.state === 'failed').length + (j.legacyFailed || 0);
    const total = j.historyComplete ? items.length : Math.max(j.wasTotal || 0, items.length + (j.legacyAdded || 0) + (j.legacyFailed || 0));
    return { total, added, failed, done: added + failed, waiting: Math.max(0, total - added - failed) };
  };
  const view = (j) => ({
    id: j.id, author: j.author, part: j.part, state: j.state,
    ...counts(j),
    open: Boolean(j.open), page: j.page ?? 0, pages: j.pages ?? null,
    say: j.say ?? null, issue: j.issue ?? null,
    unfinished: j.unfinished?.length ?? 0,
    rounds: j.rounds ?? 0, at: j.at ?? null,
    parallel: j.parallel, retrying: j.retrying ?? null, lastError: j.lastError ?? null,
  });
  const snapshot = () => jobs.map(view);
  const announce = (type, job) => onEvent({ type, job: job && view(job), jobs: snapshot() });
  const find = (id) => jobs.find((j) => j.id === id);

  /**
   * Add work, or give it to the job already doing that job.
   *
   * Opening an author twice should not start a second download of the same
   * catalogue. A job for the same author and the same half is the same job.
   */
  function add({ author, part, workIds = [], open = false }) {
    const existing = jobs.find((j) => j.author === author && j.part === part
      && j.state !== 'done' && j.state !== 'cancelled');
    if (existing) {
      if (open) existing.open = true;
      append(existing.id, workIds);
      return existing.id;
    }
    const job = {
      id: nextId++, author, part, workIds: [...new Set(workIds.map(String))],
      items: initialItems(workIds), historyComplete: true,
      done: 0, added: 0, failed: 0, open,
      /* How far through the index the walk had read, so a restart carries on
         from the next page rather than reading the whole thing again. */
      page: 0, pages: null,
      at: Date.now(),
      state: open && !workIds.length ? 'listing' : 'queued', parallel: false,
      attempt: 0, retrying: null, lastError: null,
    };
    jobs.push(job);
    announce('queued', job);
    pump();
    return job.id;
  }

  /**
   * Add more work to a job already going.
   *
   * A listing is walked a page at a time with a pause between, so waiting for
   * the whole walk before queueing anything means a minute or two of an app
   * that looks like it did nothing. The first page is queued the moment it
   * lands and the rest arrives as it is read.
   */
  function append(id, workIds) {
    const job = find(id);
    if (!job || job.state === 'done' || job.state === 'cancelled') return false;
    const known = new Set(job.items.keys());
    const fresh = [...new Set(workIds.map(String))].filter(w => !known.has(w));
    if (!fresh.length) return false;
    job.workIds.push(...fresh);
    for (const workId of fresh) itemChange(job, workId, { state: 'waiting' });
    if (job.state === 'listing') job.state = 'queued';   // it has something to do now
    announce('grew', job);
    pump();                       // a job that had finished its list resumes
    return true;
  }

  /* --------------------------------------------------------------- control */

  function pause(id) {
    const job = find(id);
    if (!job || job.state === 'done' || job.state === 'cancelled') return false;
    /* A running job stops after the work in flight; anything else — waiting
       its turn, or still reading an index — simply waits. A job reading an
       index is doing the most network of all, so it is the last thing that
       should be exempt from Pause. */
    job.state = job.state === 'running' ? 'pausing' : 'paused';
    announce('paused', job);
    return true;
  }

  function resume(id) {
    const job = find(id);
    if (!job || (job.state !== 'paused' && job.state !== 'pausing')) return false;
    job.state = job.driving ? 'running' : 'queued';
    announce('resumed', job);
    pump();
    return true;
  }

  /** End it, but leave it on the list so the reader sees what happened. */
  function stop(id) {
    const job = find(id);
    if (!job || job.state === 'done') return false;
    job.state = 'cancelled';
    announce('stopped', job);
    pump();
    return true;
  }

  /** Off the list entirely. */
  function remove(id) {
    const at = jobs.findIndex((j) => j.id === id);
    if (at === -1) return false;
    const [job] = jobs.splice(at, 1);
    job.state = 'cancelled';           // a runner mid-flight notices and stops
    announce('removed', job);
    pump();
    return true;
  }

  /**
   * Run this one now, alongside whatever is already running.
   *
   * Deliberately not a preemption: abandoning a job that is halfway through an
   * author to serve an impatient tap wastes what it had already done. Two at
   * once asks the archive for twice as much, which it may refuse — the reader
   * is spending their own account's goodwill and has said so by pressing this.
   */
  function startNow(id) {
    const job = find(id);
    if (!job || job.state === 'done' || job.state === 'cancelled') return false;
    job.parallel = true;
    if (job.state === 'paused' || job.state === 'pausing') job.state = job.driving ? 'running' : 'queued';
    announce('rushed', job);
    pump();
    return true;
  }

  const swap = (id, delta) => {
    const at = jobs.findIndex((j) => j.id === id);
    const to = at + delta;
    if (at === -1 || to < 0 || to >= jobs.length) return false;
    [jobs[at], jobs[to]] = [jobs[to], jobs[at]];
    announce('reordered', jobs[to]);
    return true;
  };
  const moveUp = (id) => swap(id, -1);
  const moveDown = (id) => swap(id, 1);

  /* ---------------------------------------------------------------- running */

  function pump() {
    // the ordinary lane: one job, in order
    const ordinary = jobs.some((j) => j.driving && !j.parallel);
    if (!ordinary) {
      const next = jobs.find((j) => j.state === 'queued' && !j.parallel);
      if (next) drive(next);
    }
    // and anything the reader has told to go now, whatever else is happening
    for (const job of jobs.filter((j) => j.state === 'queued' && j.parallel)) drive(job);
  }

  async function drive(job) {
    if (job.driving) return;
    job.driving = true;
    try {
      await runJob(job);
    } finally {
      job.driving = false;
      pump();
    }
  }

  async function runJob(job) {
    job.state = 'running';
    announce('started', job);

    while (job.done < job.workIds.length) {
      if (job.state !== 'running') break;          // paused, stopped or removed
      /* Waiting before the request rather than after the last one, so a job
         that is abandoned does not leave the next one holding its debt. */
      if (job.done > 0) await wait(gap());
      if (job.state !== 'running') break;

      const workId = job.workIds[job.done];
      itemChange(job, workId, { state: 'downloading', error: null });
      announce('item', job);
      try {
        await runTask(workId);
        itemChange(job, workId, { state: 'downloaded', error: null });
        job.attempt = 0;
      } catch (e) {
        const attempt = job.attempt ?? 0;
        if (shouldRetry(e?.message) && attempt < maxRetries) {
          /* Left where it is and tried again, longer each time. It is not
             finished with, so it does not count as done and does not count
             against the work. */
          job.attempt = attempt + 1;
          job.retrying = String(e?.message ?? '');
          itemChange(job, workId, { state: 'retrying', error: job.retrying });
          announce('retrying', job);
          await wait(retryWait(attempt));
          continue;
        }
        /*
         * A bookmark outlives the work it points at, so a failure is noted and
         * the job carries on. But there are two kinds of failure here and only
         * one of them is final: a work that is gone is gone, while one that
         * ran out of retries during an outage is unfinished business. Keeping
         * the second means a restart picks it up instead of the job reporting
         * nothing downloaded and vanishing.
         */
        job.lastError = String(e?.message ?? '');
        itemChange(job, workId, { state: 'failed', error: job.lastError, retryable: shouldRetry(e?.message) });
        if (shouldRetry(e?.message)) (job.unfinished ??= []).push(job.workIds[job.done]);
        job.attempt = 0;
        job.retrying = null;
      }
      job.done += 1;
      job.retrying = null;
      announce('progress', job);
    }

    if (job.state === 'pausing') {
      job.state = 'paused'; announce('settled', job); pump(); return;
    }
    if (job.state !== 'running') { announce('settled', job); pump(); return; }

    /* Out of work but not out of list: back to waiting rather than reporting
       itself finished, and the next page to land wakes it. */
    if (job.open) { job.state = 'listing'; announce('waiting', job); pump(); return; }

    /*
     * Having counted to the end is not the same as having got everything. Ask
     * what is still missing and go round again for those — a bounded number of
     * times, because a work the archive will not give up is not a reason to
     * ask for ever.
     */
    job.rounds = (job.rounds ?? 0) + 1;
    // Failed requests already exhausted their retry policy. Verification only
    // checks successful saves; it must not retry deleted/restricted works.
    const saved = job.workIds.filter(id => job.items.get(String(id))?.state === 'downloaded');
    let owed = [], checkError = 'No saved chapters were found after downloading.';
    try { owed = saved.length ? await verify(saved) : []; }
    catch { owed = saved; checkError = 'Could not verify the saved chapters.'; }
    owed = [...new Set(owed.map(String))].filter(id => saved.includes(id));
    for (const workId of owed) itemChange(job, workId, {
      state: 'failed', error: checkError, retryable: true,
    });
    const retry = owed.length && job.rounds < maxRounds;
    if (retry) {
      for (const workId of owed) itemChange(job, workId, { state: 'waiting' });
      job.workIds = owed;
      job.done = 0;
    }
    job.unfinished = [...job.items.values()].filter(i => i.state === 'failed' && i.retryable).map(i => i.workId);
    // A control pressed during verification still owns the decision to run.
    if (job.state === 'pausing') job.state = 'paused';
    if (job.state === 'running') job.state = retry ? 'queued' : 'done';
    announce(job.state === 'done' ? 'finished' : retry ? 'again' : 'settled', job);
    pump();
  }

  /**
   * Put a saved job back on the list without running it.
   *
   * What came back from a restart used to be only the work still owed, so a
   * job that had finished came back as nothing at all. This restores the
   * record — what was asked for and how it went — and only the ones with work
   * left are handed to the runner.
   */
  function restore(saved) {
    const owed = [...(saved.workIds ?? [])];
    const job = {
      id: nextId++, author: saved.author, part: saved.part,
      workIds: owed,
      items: initialItems([...(saved.items ?? []).map(item => item.workId).filter(Boolean), ...owed, ...(saved.unfinished ?? [])]),
      historyComplete: Boolean(saved.historyComplete),
      done: 0, added: saved.added ?? 0, failed: saved.failed ?? 0,
      open: Boolean(saved.open),
      page: saved.page ?? 0, pages: saved.pages ?? null,
      rounds: saved.rounds ?? 0, parallel: false, attempt: 0, retrying: null,
      lastError: saved.lastError ?? null,
      say: saved.say ?? null, issue: saved.issue ?? null,
      /* What it was ever about, kept as a number rather than worked out from a
         list it may have finished with. */
      wasTotal: Number(saved.total) || owed.length,
      at: saved.at ?? null,
      unfinished: saved.state === 'done' ? [...(saved.unfinished ?? [])] : [],
      state: ['done', 'cancelled', 'paused', 'pausing'].includes(saved.state)
        ? (saved.state === 'pausing' ? 'paused' : saved.state) : 'queued',
    };
    /* Anything owed by a job that had not finished goes back to waiting; a
       finished one stays finished, with what it never got still named. */
    for (const workId of saved.unfinished ?? []) itemChange(job, workId, {
      state: 'failed', error: saved.lastError || 'This work did not arrive.',
    });
    for (const item of saved.items ?? []) {
      if (!item?.workId) continue;
      const state = ['downloaded', 'failed', 'version'].includes(item.state) ? item.state : 'waiting';
      itemChange(job, item.workId, { ...item, state, workId: String(item.workId) });
    }
    const recorded = counts({ ...job, historyComplete: true });
    job.legacyAdded = job.historyComplete ? 0 : Math.max(0, (saved.added || 0) - recorded.added);
    job.legacyFailed = job.historyComplete ? 0 : Math.max(0, (saved.failed || 0) - recorded.failed);
    if (job.state === 'queued' && !job.workIds.length) job.state = job.open ? 'listing' : 'done';
    jobs.push(job);
    announce('restored', job);
    if (job.state === 'queued') pump();
    return job.id;
  }


  /**
   * Do it again: what a finished job could not get, or the whole list if it
   * got everything. A job that reported itself done while leaving works
   * behind was the thing there was no way to act on.
   */
  function rerun(id) {
    const job = find(id);
    if (!job || job.driving || !['done', 'cancelled'].includes(job.state)) return false;
    const again = job.unfinished?.length ? job.unfinished : job.workIds;
    if (!again.length) return false;
    job.workIds = [...again];
    for (const workId of again) itemChange(job, workId, { state: 'waiting', error: null });
    job.done = 0; job.added = 0; job.failed = 0;
    job.unfinished = []; job.rounds = 0;
    job.lastError = null; job.issue = null; job.attempt = 0;
    job.state = 'queued';
    announce('again', job);
    pump();
    return true;
  }

  /**
   * May this job make another request, and if not yet, wait until it may.
   *
   * A job is one thing to the person who started it — reading an index and
   * fetching what it names — and it was two machines to the app: the queue,
   * which honoured Pause, and the listing walk, which had never heard of it.
   * So Pause stopped the downloading and left the walk asking the archive for
   * page after page. Every long loop asks this before its next turn.
   *
   * Returns false when there is nothing left to run for: stopped, or gone.
   */
  async function waitUntilRunnable(id) {
    for (;;) {
      const job = find(id);
      if (!job || job.state === 'cancelled') return false;
      if (job.state !== 'paused' && job.state !== 'pausing') return true;
      /* A floor, so this cannot become a spin if the gap is ever nothing. It
         is asking how long somebody has left it paused, which is not a
         question worth asking many times a second. */
      await wait(Math.max(1000, gap()));
    }
  }

  /** Whether this job has been stopped or removed out from under a loop. */
  function isStopped(id) {
    const job = find(id);
    return !job || job.state === 'cancelled';
  }

  /**
   * The list is complete: whatever is in the job now is all of it.
   *
   * Called when a walk ends, however it ended. A job left open by a walk that
   * failed would sit saying it was still reading for ever.
   */
  /** The walk reporting where it has got to, so a restart can pick it up. */
  function note(id, { page, pages, say, issue } = {}) {
    const job = find(id);
    if (!job) return false;
    if (page != null) job.page = page;
    if (pages != null) job.pages = pages;
    /* Some work does not end in a count of downloads. A bookmark list that was
       read and agreed with has an outcome worth keeping, and nowhere to put it
       among added, failed and total. */
    if (say != null) job.say = say;
    if (issue !== undefined) job.issue = issue;
    announce('noted', job);
    return true;
  }

  function seal(id) {
    const job = find(id);
    if (!job) return false;
    job.open = false;
    if (job.state === 'listing') {
      job.state = job.workIds.length ? 'queued' : 'done';
      announce(job.state === 'done' ? 'finished' : 'sealed', job);
      pump();
    }
    return true;
  }

  /** Imported books use the same result view without entering the network queue. */
  function record(id, item) {
    const job = find(id);
    if (!job || !item?.workId) return false;
    itemChange(job, item.workId, item);
    announce('item', job);
    return true;
  }

  function details(id) {
    const job = find(id);
    return job ? { ...view(job), historyComplete: job.historyComplete,
      items: [...job.items.values()].map(item => ({ ...item })) } : null;
  }

  const savedJobs = () => {
    const settled = j => ['done', 'cancelled'].includes(j.state);
    const recent = new Set(jobs.filter(settled).slice(-40));
    return jobs.filter(j => !settled(j) || recent.has(j));
  };

  return {
    add, append, note, seal, rerun, restore, record, details,
    waitUntilRunnable, isStopped,
    pause, resume, stop, remove, startNow, moveUp, moveDown,
    list: snapshot,
    /**
     * What is left, so a restart resumes rather than starting over.
     *
     * A job still reading its index is kept even with nothing left to fetch.
     * It used to be dropped: the list it had was finished, the pages it had
     * not read yet were not written down anywhere, and the whole job — walk
     * included — disappeared when the app was closed.
     */
    /* Finished jobs are kept too, so the list survives a restart and what
       never arrived can still be asked for again. Bounded: this is a record
       of recent work, not a log. */
    /**
     * The jobs themselves, not a summary of them.
     *
     * This used to hand back a description — what was left, how it went — and
     * the other side built a job out of that description. Every round trip
     * through those two lost something: first the totals, then the times,
     * then the work still owed. The cure is not a better description. It is
     * to write down the job and read the job back.
     *
     * Pending work and per-work results are separate. A restart resumes only
     * pending requests, while completed work remains inspectable in its job.
     *
     * Bounded to the last forty: a record of recent work, not a log.
     */
    save: () => savedJobs()
      .map((j) => {
        const settled = j.state === 'done';
        return {
          author: j.author, part: j.part,
          state: j.state,
          items: [...j.items.values()].map(item => ({ ...item })),
          historyComplete: j.historyComplete,
          workIds: settled
            ? [...(j.unfinished ?? [])]
            : [...new Set([...j.workIds.slice(j.done), ...(j.unfinished ?? [])])],
          unfinished: [...(j.unfinished ?? [])],
          total: counts(j).total,
          added: counts(j).added, failed: counts(j).failed,
          open: Boolean(j.open), page: j.page ?? 0, pages: j.pages ?? null,
          rounds: j.rounds ?? 0,
          lastError: j.lastError ?? null,
          say: j.say ?? null, issue: j.issue ?? null,
          at: j.at ?? null,
        };
      })
  };
}
