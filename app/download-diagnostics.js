// Only aggregate numbers cross the diagnostic bridge. No work/author identifiers.
export const diagnosticStates = ['queued', 'listing', 'running', 'pausing', 'paused', 'done', 'cancelled', 'error'];
export function diagnosticProgress(job = {}) {
  const values = { state: diagnosticStates.indexOf(job.state) };
  for (const key of ['total', 'added', 'failed', 'page', 'pages']) {
    const value = Number(job[key]);
    if (Number.isFinite(value) && value >= 0) values[key] = value;
  }
  return values;
}
export function diagnosticQueue(list, waits, coolUntil, lastProgress, hidden, now = Date.now()) {
  const values = { running: 0, queued: 0, listing: 0, paused: 0, waits: waits.size,
    cooldownMs: Math.max(0, coolUntil - now), progressAgeMs: Math.max(0, now - lastProgress),
    overdueMs: 0, hidden: Boolean(hidden) };
  for (const job of list) {
    if (job.state === 'pausing') values.paused++;
    else if (['running', 'queued', 'listing', 'paused'].includes(job.state)) values[job.state]++;
  }
  for (const wait of waits) values.overdueMs = Math.max(values.overdueMs, now - wait.due);
  return values;
}
