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

  const view = (j) => ({
    id: j.id, author: j.author, part: j.part, state: j.state,
    /* How many it was ever about. A running job knows from its own list; a
       finished one has emptied that list, so it has to have been kept — which
       it was not, and every restored record read 0 of 0 and then saved those
       zeros back over what it had actually done. */
    total: j.workIds.length || j.wasTotal || 0,
    done: j.done, added: j.added, failed: j.failed,
    /* Open means the list is still being read, so `total` is what is known so
       far rather than what there will be — the difference between a bar that
       can be trusted and one that slides backwards. */
    open: Boolean(j.open),
    /* Where a walk has got to. A job that reads an index rather than a list of
       works has no works to count, and "0 of 0" is what that looked like from
       the outside — so the pages it is actually walking are part of what a job
       can say about itself. */
    page: j.page ?? 0, pages: j.pages ?? null,
    /* A line the job has written about itself, for work whose outcome is not a
       number of downloads: how many bookmarks were read, what changed. */
    say: j.say ?? null,
    /* Work that ran out of retries rather than being refused, or that the
       database says never arrived: still owed either way. */
    unfinished: j.unfinished?.length ?? 0,
    rounds: j.rounds ?? 0,
    at: j.at ?? null,
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
      id: nextId++, author, part, workIds: [...workIds],
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
    const known = new Set(job.workIds);
    const fresh = workIds.filter((w) => !known.has(w));
    if (!fresh.length) return false;
    job.workIds.push(...fresh);
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
    job.state = 'queued';
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
    if (job.state === 'paused' || job.state === 'pausing') job.state = 'queued';
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
    const ordinary = jobs.some((j) => j.state === 'running' && !j.parallel);
    if (!ordinary) {
      const next = jobs.find((j) => j.state === 'queued' && !j.parallel);
      if (next) drive(next);
    }
    // and anything the reader has told to go now, whatever else is happening
    for (const job of jobs.filter((j) => j.state === 'queued' && j.parallel)) drive(job);
  }

  async function drive(job) {
    if (job.state === 'running') return;
    job.state = 'running';
    announce('started', job);

    while (job.done < job.workIds.length) {
      if (job.state !== 'running') break;          // paused, stopped or removed
      /* Waiting before the request rather than after the last one, so a job
         that is abandoned does not leave the next one holding its debt. */
      if (job.done > 0) await wait(gap());
      if (job.state !== 'running') break;

      try {
        await runTask(job.workIds[job.done]);
        job.added += 1;
        job.attempt = 0;
      } catch (e) {
        const attempt = job.attempt ?? 0;
        if (shouldRetry(e?.message) && attempt < maxRetries) {
          /* Left where it is and tried again, longer each time. It is not
             finished with, so it does not count as done and does not count
             against the work. */
          job.attempt = attempt + 1;
          job.retrying = String(e?.message ?? '');
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
        job.failed += 1;
        job.lastError = String(e?.message ?? '');
        if (shouldRetry(e?.message)) (job.unfinished ??= []).push(job.workIds[job.done]);
        job.attempt = 0;
        job.retrying = null;
      }
      job.done += 1;
      job.retrying = null;
      announce('progress', job);
    }

    if (job.state === 'pausing') {
      job.state = 'paused'; announce('finished', job); pump(); return;
    }
    if (job.state !== 'running') { announce('finished', job); pump(); return; }

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
    let owed = [];
    try { owed = await verify(job.workIds); } catch { owed = []; }

    if (owed.length && job.rounds < maxRounds) {
      job.workIds = owed;
      job.done = 0;
      job.unfinished = [];
      job.state = 'queued';
      announce('again', job);
      pump();
      return;
    }

    /* Out of rounds with work still missing: owed, not delivered, so it is
       kept and saved rather than quietly counted as done. */
    if (owed.length) job.unfinished = owed;
    job.state = 'done';
    announce('finished', job);
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
      done: 0, added: saved.added ?? 0, failed: saved.failed ?? 0,
      open: Boolean(saved.open),
      page: saved.page ?? 0, pages: saved.pages ?? null,
      rounds: saved.rounds ?? 0, parallel: false, attempt: 0, retrying: null,
      lastError: saved.lastError ?? null,
      say: saved.say ?? null,
      /* What it was ever about, kept as a number rather than worked out from a
         list it may have finished with. */
      wasTotal: Number(saved.total) || owed.length,
      at: saved.at ?? null,
      unfinished: saved.state === 'done' ? [...(saved.unfinished ?? [])] : [],
      state: saved.state === 'done' ? 'done' : 'queued',
    };
    /* Anything owed by a job that had not finished goes back to waiting; a
       finished one stays finished, with what it never got still named. */
    if (job.state !== 'done' && !job.workIds.length) job.state = job.open ? 'listing' : 'done';
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
    if (!job) return false;
    const again = job.unfinished?.length ? job.unfinished : job.workIds;
    if (!again.length) return false;
    job.workIds = [...again];
    job.done = 0; job.added = 0; job.failed = 0;
    job.unfinished = []; job.rounds = 0;
    job.lastError = null; job.attempt = 0;
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
  function note(id, { page, pages, say } = {}) {
    const job = find(id);
    if (!job) return false;
    if (page != null) job.page = page;
    if (pages != null) job.pages = pages;
    /* Some work does not end in a count of downloads. A bookmark list that was
       read and agreed with has an outcome worth keeping, and nowhere to put it
       among added, failed and total. */
    if (say != null) job.say = say;
    announce('noted', job);
    return true;
  }

  function seal(id) {
    const job = find(id);
    if (!job) return false;
    job.open = false;
    if (job.state === 'listing') {
      job.state = job.done >= job.workIds.length ? 'done' : 'queued';
      announce(job.state === 'done' ? 'finished' : 'sealed', job);
      pump();
    }
    return true;
  }

  return {
    add, append, note, seal, rerun, restore,
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
     * A finished job keeps its counts and whatever it never got, and lets go
     * of the ids it delivered — those are in the library now, and thousands
     * of them are not worth carrying around to say a job went well.
     *
     * Bounded to the last forty: a record of recent work, not a log.
     */
    save: () => jobs
      .filter((j) => j.state !== 'cancelled')
      .slice(-40)
      .map((j) => {
        const settled = j.state === 'done';
        return {
          author: j.author, part: j.part,
          state: j.state,
          workIds: settled
            ? [...(j.unfinished ?? [])]
            : [...j.workIds.slice(j.done), ...(j.unfinished ?? [])],
          unfinished: [...(j.unfinished ?? [])],
          total: j.workIds.length || j.wasTotal || 0,
          added: j.added, failed: j.failed,
          open: Boolean(j.open), page: j.page ?? 0, pages: j.pages ?? null,
          rounds: j.rounds ?? 0,
          lastError: j.lastError ?? null,
          say: j.say ?? null,
          at: j.at ?? null,
        };
      })
  };
}
