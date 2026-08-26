/**
 * The part that keeps this from looking like a scrape.
 *
 * AO3 publishes no rate limit, so this is conservative by construction rather
 * than tuned to a number: one request at a time, a floor on the gap between
 * them, and immediate surrender the moment the server pushes back. The clock
 * and the sleep are injected so the tests exercise the real backoff logic
 * without ever waiting.
 *
 * Anything that must survive a crash belongs to the caller. This owns pacing
 * and retries; the caller owns the cursor. That split is deliberate — a queue
 * that also remembered progress would have to be trusted with correctness it
 * cannot check.
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Statuses worth trying again. Everything else is the answer, right or not. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class BudgetSpent extends Error {
  constructor(spent) {
    super(`request budget of ${spent} used up`);
    this.name = 'BudgetSpent';
  }
}

export function createLimiter({
  minInterval = 5000,       // 12 requests a minute, single file
  jitter = 0.2,             // ±20%, so the pattern is not metronomic
  maxRetries = 5,
  maxBackoff = 15 * 60_000,
  budget = Infinity,
  now = () => Date.now(),
  sleep = defaultSleep,
  random = Math.random,
  onEvent = () => {},
} = {}) {
  let last = null;   // null means nothing has gone out yet
  let spent = 0;
  let chain = Promise.resolve();
  const stats = { requests: 0, retries: 0, waited: 0, throttled: 0 };

  /**
   * How long to leave before the next request.
   *
   * A fixed interval with ±20% jitter puts every single gap in a four-second
   * band — a pattern nothing human produces, and a trivial one to spot. Real
   * reading is bursty: mostly short gaps, a long tail, and the occasional
   * proper pause where someone actually reads the page or puts the phone down.
   *
   * So gaps are drawn from an exponential distribution (memoryless, which is
   * what arrival times of a person actually look like) with a floor, plus an
   * occasional long pause. The mean stays near minInterval, so politeness is
   * unchanged — only the predictability goes.
   */
  const gap = () => {
    if (jitter === 0) return minInterval;                  // tests want determinism
    if (random() < 0.08) return minInterval * (4 + random() * 8);  // stepped away
    const tail = -Math.log(1 - random());                  // exponential, mean 1
    return Math.max(minInterval * 0.45, minInterval * (0.35 + tail * 0.75));
  };

  async function pace() {
    // the first request of a run has nothing to be polite about yet; making it
    // wait just adds a pointless interval to every sync
    if (last === null) { last = now(); return; }
    const due = last + gap();
    const wait = due - now();
    if (wait > 0) { stats.waited += wait; await sleep(wait); }
    last = now();
  }

  /**
   * Retry-After is authoritative when present: it is the server saying exactly
   * how long to go away for, and guessing shorter is how a slow crawler turns
   * into a blocked one.
   */
  function backoffFor(response, attempt) {
    const header = response?.headers?.get?.('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds)) return Math.min(seconds * 1000, maxBackoff);
      const when = Date.parse(header);
      if (Number.isFinite(when)) return Math.min(Math.max(when - now(), 0), maxBackoff);
    }
    return Math.min(60_000 * 2 ** attempt, maxBackoff);
  }

  /**
   * Run one request. `task` is called with the attempt number and must return
   * something response-shaped ({ status, headers }) or throw.
   */
  function run(task, { label = '' } = {}) {
    const mine = chain.then(async () => {
      if (spent >= budget) throw new BudgetSpent(budget);
      for (let attempt = 0; ; attempt++) {
        await pace();
        spent++;
        stats.requests++;
        let response;
        try {
          response = await task(attempt);
        } catch (err) {
          if (attempt >= maxRetries) throw err;
          stats.retries++;
          onEvent({ type: 'error', label, attempt, error: err.message });
          await sleep(backoffFor(null, attempt));
          continue;
        }
        if (!RETRYABLE.has(response?.status)) return response;
        if (attempt >= maxRetries) return response;
        const wait = backoffFor(response, attempt);
        stats.retries++;
        if (response.status === 429) stats.throttled++;
        onEvent({ type: 'backoff', label, status: response.status, attempt, wait });
        await sleep(wait);
      }
    });
    // one failure must not poison the queue for every task behind it
    chain = mine.then(() => {}, () => {});
    return mine;
  }

  return { run, stats, get spent() { return spent; } };
}
