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
          text: async () => result.body });
      } catch (error) { pending.delete(id); settle.reject(error); }
    }
    if (!pending.size && timer !== null) { clearTimer(timer); timer = null; }
    schedule();
  }
  function request(url) {
    if (!native) return fetchPage(url);
    return new Promise((resolve, reject) => {
      try {
        const id = Number(native.startArchiveRequest(String(url)));
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Could not start archive request');
        pending.set(id, { resolve, reject });
        poll();
      } catch (error) { reject(error); }
    });
  }
  return { request, poll, pendingCount: () => pending.size };
}
