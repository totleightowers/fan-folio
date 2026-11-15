/** Feed the ordinary paced queue without repeatedly retrying unavailable works. */
export const AUTO_DOWNLOAD_SOURCE = 'saved-auto';
export const isAutoDownload = job => job?.source?.kind === AUTO_DOWNLOAD_SOURCE;
const live = job => !['done', 'cancelled'].includes(job.state);

export function createAutoDownloads({ queue, missing, read, write, canRun, batchSize = 2000 }) {
  let ready = false, busy = false;
  let enabled = false, paused = false, considered = new Set();
  const persist = () => write({ enabled, paused, considered: [...considered] });
  const own = () => queue.list().filter(isAutoDownload);

  function refresh() {
    if (!ready || busy || !enabled || paused || !canRun()) return;
    busy = true;
    try {
      // Recover the small window between persisting a job and our attempt list.
      for (const job of own()) {
        for (const item of queue.details(job.id)?.items ?? []) considered.add(String(item.workId));
      }
      if (own().some(live)) return;
      const pending = new Set();
      for (const job of queue.list().filter(live)) {
        for (const item of queue.details(job.id)?.items ?? []) {
          if (['waiting', 'downloading', 'retrying'].includes(item.state)) pending.add(String(item.workId));
        }
      }
      const ids = [...new Set(missing().map(String))]
        .filter(id => !considered.has(id) && !pending.has(id)).slice(0, batchSize);
      if (!ids.length) return;
      queue.add({ author: 'Your library', part: 'automatic downloads',
        source: { kind: AUTO_DOWNLOAD_SOURCE }, workIds: ids });
      for (const id of ids) considered.add(id);
      persist();
    } finally { busy = false; }
  }

  return {
    start() {
      const saved = read() ?? {};
      enabled = saved.enabled === true;
      paused = saved.paused === true;
      considered = new Set(Array.isArray(saved.considered) ? saved.considered.map(String) : []);
      ready = true;
    },
    state: () => ({ enabled, paused }),
    refresh,
    setEnabled(value) {
      enabled = Boolean(value);
      if (enabled) paused = false;
      persist();
      for (const job of own().filter(live)) {
        if (enabled) queue.resume(job.id); else queue.pause(job.id);
      }
      refresh();
    },
    pause() { paused = true; persist(); },
    resume() { paused = false; persist(); refresh(); },
    stop() { enabled = false; persist(); },
    event({ type, job }) {
      if (!ready || !isAutoDownload(job)) return;
      // An explicit Resume on this job is also an explicit opt-in.
      if (type === 'resumed') { enabled = true; paused = false; persist(); }
      if (!enabled) return;
      if (type === 'paused') { paused = true; persist(); }
      if (type === 'stopped' || (type === 'removed' && job.waiting > 0)) { enabled = false; persist(); }
    },
  };
}
