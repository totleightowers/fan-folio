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

export const STATES = ['queued', 'running', 'paused', 'cancelled', 'done'];

export function createQueue({
  runTask,
  wait,
  gap,
  onEvent = () => {},
} = {}) {
  const jobs = [];

  const view = (j) => ({
    id: j.id, author: j.author, part: j.part, state: j.state,
    total: j.workIds.length, done: j.done, added: j.added, failed: j.failed,
    parallel: j.parallel,
  });
  const snapshot = () => jobs.map(view);
  const announce = (type, job) => onEvent({ type, job: job && view(job), jobs: snapshot() });
  const find = (id) => jobs.find((j) => j.id === id);

  function add({ author, part, workIds }) {
    const job = {
      id: nextId++, author, part, workIds: [...workIds],
      done: 0, added: 0, failed: 0, state: 'queued', parallel: false,
    };
    jobs.push(job);
    announce('queued', job);
    pump();
    return job.id;
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
      } catch {
        // a bookmark outlives the work it points at: note it and carry on
        job.failed += 1;
      }
      job.done += 1;
      announce('progress', job);
    }

    if (job.state === 'pausing') job.state = 'paused';
    else if (job.state === 'running') job.state = 'done';
    announce('finished', job);
    pump();
  }

  return {
    add, pause, resume, stop, remove, startNow, moveUp, moveDown,
    list: snapshot,
    /** What is left, so a restart resumes rather than starting over. */
    save: () => jobs
      .filter((j) => j.state !== 'done' && j.state !== 'cancelled')
      .map((j) => ({ author: j.author, part: j.part, workIds: j.workIds.slice(j.done) })),
  };
}
