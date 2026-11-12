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

/**
 * Where a script error happened, and nothing about what it was handling.
 *
 * "js_error" with no detail says only that something broke. The kind of error
 * and the places in our own files it passed through are enough to find it,
 * and neither can hold a title or a name. The message is left out on purpose:
 * a JSON parse error quotes the text it choked on.
 */
const FRAME = /(?:at\s+(?:async\s+)?([\w$.<>]+)\s+\()?(?:https?:\/\/[^/\s)]+)?\/([\w./-]+\.m?js):(\d+):(\d+)/;
export function diagnosticError(event = {}) {
  const error = event.error ?? event.reason;
  const values = {};
  const kind = String(error?.name ?? '');
  values.kind = /^[A-Za-z]{1,40}$/.test(kind) ? kind : 'Unknown';
  const frames = [];
  for (const line of String(error?.stack ?? '').split('\n')) {
    const m = FRAME.exec(line);
    if (m) frames.push(`${m[1] ?? '-'}@${m[2]}:${m[3]}:${m[4]}`);
    if (frames.length === 6) break;
  }
  if (!frames.length && event.filename) {
    const m = /^\/([\w./-]+\.m?js)$/.exec(String(event.filename).split(/[?#]/)[0].replace(/^https?:\/\/[^/]+/, ''));
    if (m && Number.isFinite(event.lineno)) frames.push(`-@${m[1]}:${event.lineno}:${event.colno ?? 0}`);
  }
  if (frames.length) values.where = frames.join('|').slice(0, 600);
  return values;
}
