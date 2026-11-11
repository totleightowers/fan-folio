/** Android starts HTTP directly; the service tick can collect results with browser timers suspended. */
export function createArchiveTransport({ native, fetchPage, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const pending = new Map();
  let timer = null;
  function schedule() {
    if (pending.size && timer === null) timer = setTimer(() => { timer = null; poll(); }, 250);
  }
  function poll() {
    for (const [id, settle] of pending) {
      try {
        const raw = native.takeArchiveResponse(id);
        if (!raw) continue;
        const result = JSON.parse(raw);
        if (!Number.isInteger(result.status) || typeof result.body !== 'string') throw new Error('Invalid archive response');
        pending.delete(id);
        settle.resolve({ status: result.status, ok: result.status >= 200 && result.status < 300,
          headers: new Headers(result.headers || {}),
          text: async () => result.body });
      } catch (error) { pending.delete(id); settle.reject(error); }
    }
    if (!pending.size && timer !== null) { clearTimer(timer); timer = null; }
    schedule();
  }
  function request(url, publicRead = false) {
    if (!native) {
      if (publicRead) throw new Error('Recovery needs the updated Android app');
      return fetchPage(url);
    }
    return new Promise((resolve, reject) => {
      try {
        const id = Number(publicRead ? native.startRecoveryRequest(String(url)) : native.startArchiveRequest(String(url)));
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Could not start archive request');
        pending.set(id, { resolve, reject });
        poll();
      } catch (error) { reject(error); }
    });
  }
  return { request, requestPublic: url => request(url, true), poll, pendingCount: () => pending.size };
}
/** Retry-After is either seconds or an HTTP date. Never shorten a server wait. */
export function archiveRetryAfter(headers, now = Date.now()) {
  const value = headers?.get?.('Retry-After')?.trim();
  if (!value) return 5 * 60_000;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(5 * 60_000, ms) : 5 * 60_000;
}

/** A throttled recovery provider is not retried for every work in the queue. */
export function createPublicRecoveryRequests(request, now = Date.now) {
  const cooling = new Map();
  return async url => {
    const host = new URL(url).hostname;
    const provider = ['archive.org', 'web.archive.org'].includes(host) ? 'wayback' : host;
    const until = cooling.get(provider) || 0;
    if (until > now()) return {status:429,ok:false,headers:new Headers(),text:async()=>''};
    const response = await request(url);
    if (response.status === 429) cooling.set(provider, now() + archiveRetryAfter(response.headers, now()));
    return response;
  };
}
