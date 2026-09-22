/** Describe the existing queue without changing its scheduling or retry policy. */
export function downloadStatus(jobs, { now = Date.now(), coolUntil = 0 } = {}) {
  const active = jobs.filter(j => ['running', 'queued', 'listing'].includes(j.state));
  const paused = jobs.filter(j => ['paused', 'pausing'].includes(j.state));
  const missing = jobs.reduce((n, j) => n + Math.max(Number(j.failed) || 0, Number(j.unfinished) || 0), 0);
  const issues = jobs.filter(j => j.issue).length;
  const added = jobs.reduce((n, j) => n + (Number(j.added) || 0), 0);
  if (active.length && coolUntil > now) return { title: 'Waiting for the archive',
    detail: `Cooling down for about ${Math.ceil((coolUntil - now) / 60000)} minutes. Downloads will continue automatically.`, active: active.length, paused: paused.length };
  if (active.length) return { title: active.some(j => j.retrying) ? 'Retrying a request' : 'Downloads in progress',
    detail: `${active.length} active · ${paused.length} paused. Newly opened works get priority.`, active: active.length, paused: paused.length };
  if (paused.length) return { title: 'Downloads paused', detail: `${paused.length} paused. Resume when you are ready.`, active: 0, paused: paused.length };
  if (missing || issues) return { title: 'Some works still need attention', detail: `${added} downloaded · ${missing} did not arrive.${issues ? ` ${issues} incomplete listing${issues === 1 ? '' : 's'}.` : ''} Review the jobs below.`, active: 0, paused: 0 };
  if (jobs.some(j => j.state === 'cancelled')) return { title: 'Downloads stopped', detail: `${added} downloaded. Stopped jobs are kept below and can be run again.`, active: 0, paused: 0 };
  return { title: jobs.length ? 'Up to date with this queue' : 'Nothing downloading',
    detail: jobs.length ? `${added} downloaded. Completed jobs are kept below.` : 'Add a link, import EPUBs or sync bookmarks to bring works in.', active: 0, paused: 0 };
}
