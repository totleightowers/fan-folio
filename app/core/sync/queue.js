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
} = {}) {
  const jobs = [];

  const view = (j) => ({
    id: j.id, author: j.author, part: j.part, state: j.state,
    total: j.workIds.length, done: j.done, added: j.added, failed: j.failed,
    /* Open means the list is still being read, so `total` is what is known so
       far rather than what there will be — the difference between a bar that
       can be trusted and one that slides backwards. */
    open: Boolean(j.open),
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
    // a running job stops after the work in flight; an unstarted one just waits
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
        // a bookmark outlives the work it points at: note it and carry on
        job.failed += 1;
        job.lastError = String(e?.message ?? '');
        job.attempt = 0;
        job.retrying = null;
      }
      job.done += 1;
      job.retrying = null;
      announce('progress', job);
    }

    if (job.state === 'pausing') job.state = 'paused';
    /* Out of work but not out of list: it goes back to waiting rather than
       reporting itself finished, and the next page to land wakes it. */
    else if (job.state === 'running') job.state = job.open ? 'listing' : 'done';
    announce(job.state === 'listing' ? 'waiting' : 'finished', job);
    pump();
  }

  /**
   * The list is complete: whatever is in the job now is all of it.
   *
   * Called when a walk ends, however it ended. A job left open by a walk that
   * failed would sit saying it was still reading for ever.
   */
  /** The walk reporting where it has got to, so a restart can pick it up. */
  function note(id, { page, pages } = {}) {
    const job = find(id);
    if (!job) return false;
    if (page != null) job.page = page;
    if (pages != null) job.pages = pages;
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
    add, append, note, seal, pause, resume, stop, remove, startNow, moveUp, moveDown,
    list: snapshot,
    /**
     * What is left, so a restart resumes rather than starting over.
     *
     * A job still reading its index is kept even with nothing left to fetch.
     * It used to be dropped: the list it had was finished, the pages it had
     * not read yet were not written down anywhere, and the whole job — walk
     * included — disappeared when the app was closed.
     */
    save: () => jobs
      .filter((j) => j.state !== 'done' && j.state !== 'cancelled')
      .map((j) => ({
        author: j.author, part: j.part,
        workIds: j.workIds.slice(j.done),
        open: Boolean(j.open), page: j.page ?? 0, pages: j.pages ?? null,
      }))
      .filter((j) => j.workIds.length || j.open),
  };
}
