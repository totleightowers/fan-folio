/**
 * A logged-in, well-behaved AO3 client for development runs.
 *
 * The phone app will get its cookies from the WebView instead, but everything
 * below the cookie source — pacing, backoff, parsing — is the same code, so
 * what is proven here is what ships.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createLimiter } from '../../app/core/queue.js';

export const JAR = join(homedir(), '.config', 'archive-reader', 'cookies.txt');
/**
 * How this client presents itself.
 *
 * A judgement call, made deliberately. AO3 asks automated clients to identify
 * themselves, and the honest string below is what we started with — but a
 * non-browser User-Agent with three headers gets throttled far harder than a
 * browser does, and the traffic here IS a person reading their own account at
 * roughly two requests a minute. Presenting as the browser on the device that
 * is actually making the request is closer to the truth of what is happening
 * than a bot string attached to human-paced, human-owned, personal traffic.
 *
 * Set AO3_IDENTIFY=1 to go back to announcing ourselves as a tool.
 */
const HONEST_UA = 'ArchiveReader/0.1 (personal offline reader for my own AO3 account)';
const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const IDENTIFY = process.env.AO3_IDENTIFY === '1';
const UA = IDENTIFY ? HONEST_UA : BROWSER_UA;

/** What that browser actually sends. Partial headers are their own signature. */
function browserHeaders(referer) {
  const h = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9',
    // node's fetch decompresses transparently; 229KB pages become ~40KB on the
    // wire, which is a real kindness to AO3 as well as to the phone
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
  };
  // someone on page 7 got there from page 6; arriving with no referer at all,
  // page after page, is not what browsing looks like
  if (referer) h.Referer = referer;
  return h;
}

/** Netscape cookie file → a Cookie header. Tab-separated, comments skipped. */
export async function cookieHeader(path = JAR) {
  const text = await readFile(path, 'utf8');
  const pairs = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [name, value] = [f[5], f[6]];
    if (!name) continue;
    // Cloudflare's bot-management cookies are bound to the client they were
    // issued to. These were minted for python-urllib during login; replaying
    // them from node while claiming to be Chrome is a contradiction Cloudflare
    // is specifically built to notice. Dropping them lets it issue fresh ones
    // that match whoever is actually asking.
    if (name.startsWith('__cf') || name === '_cfuvid') continue;
    if (name === 'flash_is_set') continue;      // a spent one-shot flag
    pairs.push(`${name}=${value}`);
  }
  if (!pairs.length) throw new Error(`no cookies in ${path} — run tools/ao3-login.py`);
  return pairs.join('; ');
}

/**
 * 5s (12/min) drew a 429 with an 8.6-minute Retry-After on logged-in listing
 * pages within four requests. Those pages are expensive for AO3 to build and
 * are throttled harder than public ones, so the default is deliberately slow:
 * one penalty costs more wall-clock than all the extra gaps it would buy.
 * Override with AO3_MIN_INTERVAL for runs known to be cheap.
 */
const DEFAULT_INTERVAL = Number(process.env.AO3_MIN_INTERVAL ?? 20000);

/**
 * When AO3 hands out a penalty it outlives this process, so it is written
 * down. A restart that walks straight back into an open window renews the
 * penalty instead of serving it — which turned an 8.6 minute wait into a
 * cascade of escalating 503s the first time this ran.
 */
const COOLDOWN = join(homedir(), '.config', 'archive-reader', 'cooldown');

async function cooldownRemaining() {
  try {
    const until = Number(await readFile(COOLDOWN, 'utf8'));
    return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
  } catch { return 0; }
}

async function recordCooldown(ms) {
  try {
    await mkdir(dirname(COOLDOWN), { recursive: true });
    await writeFile(COOLDOWN, String(Date.now() + ms));
  } catch { /* advisory only — never fail a run over it */ }
}

export async function createClient({ minInterval = DEFAULT_INTERVAL, budget = Infinity, verbose = true, startDelay = 0 } = {}) {
  const cookie = await cookieHeader();
  // returning to AO3 while a penalty window is still open just earns a longer one
  // seconds, because every caller of this thinks in seconds and the one that
  // thought in milliseconds waited 420ms instead of 7 minutes
  const waitMs = Math.max(startDelay * 1000, await cooldownRemaining());
  if (waitMs > 0) {
    console.error(`waiting ${Math.round(waitMs / 1000)}s before the first request `
      + `(${startDelay ? 'requested' : 'penalty still open'})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const limiter = createLimiter({
    minInterval,
    budget,
    onEvent: (e) => {
      if (!verbose) return;
      if (e.type === 'backoff') {
        console.error(`  ! ${e.status} on ${e.label} — waiting ${Math.round(e.wait / 1000)}s`);
        recordCooldown(e.wait);
      }
      else console.error(`  ! ${e.error} on ${e.label} (attempt ${e.attempt})`);
    },
  });

  let referer = null;
  async function get(url, { label = url } = {}) {
    const res = await limiter.run(
      () => fetch(url, { headers: { ...browserHeaders(referer), Cookie: cookie }, redirect: 'follow' }),
      { label }
    );
    referer = url;
    const body = await res.text();
    // AO3 answers an expired session with a login page and a 200, so status
    // alone is not proof the request did what it was asked to
    if (/<title>\s*Log In/i.test(body)) {
      throw new Error('AO3 returned the login page — the session has expired, log in again');
    }
    return { status: res.status, body, headers: res.headers };
  }

  return { get, limiter };
}
