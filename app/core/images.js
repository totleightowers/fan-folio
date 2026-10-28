/** One image request at a time per reading visit; leaving a chapter stops the loop. */
export function createImageCollector({ fetchNext, isCurrent, proxy, onImage, onProgress, wait }) {
  let active = null;
  return {
    start(workId, chapter) {
      const key = `${workId}:${chapter}`;
      if (active?.key === key && !active.cancelled) return active.promise;
      if (active) active.cancelled = true;
      const previous = active?.promise;
      const run = { key, cancelled: false };
      active = run;
      run.promise = (async () => {
        if (previous) await previous.catch(() => {});
        const result = { saved: 0, failed: 0, cancelled: false };
        const seen = new Set();
        while (!run.cancelled && isCurrent(workId, chapter)) {
          const out = await fetchNext(workId, { chapter, proxy: proxy() });
          if (out.done) return result;
          if (!out.url || seen.has(out.url)) throw new Error(out.error || 'Image recovery could not continue');
          seen.add(out.url);
          if (out.sha256) result.saved++;
          else {
            result.failed++;
            result.lastError = out.error || 'Image unavailable';
          }
          if (!run.cancelled && isCurrent(workId, chapter)) {
            if (out.sha256) onImage(out);
            onProgress(result);
          }
          await wait(250);
        }
        return { ...result, cancelled: true };
      })().finally(() => { if (active === run) active = null; });
      return run.promise;
    },
    async cancel() {
      if (!active) return;
      active.cancelled = true;
      await active.promise.catch(() => {});
    },
  };
}

/** Only completed, broken local loads are retried; a pending image is not a failure. */
export function brokenStoredImages(images) {
  const found = new Map();
  for (const img of images) {
    if (!img.complete || img.naturalWidth > 0 || img.dataset.stored !== '1') continue;
    const url = img.dataset.remoteSrc;
    const sha = /^\/img\/([a-f0-9]{64})(?:[?]|$)/.exec(img.getAttribute('src') || '')?.[1];
    if (sha && /^https?:\/\//i.test(url || '')) found.set(url, { url, sha256: sha });
  }
  return [...found.values()];
}

export function imageResult({ saved, failed, lastError }) {
  return `${saved} image${saved === 1 ? '' : 's'} saved${failed ? ` · ${failed} still unavailable${lastError ? ` · ${lastError}` : ''}` : ''}`;
}

/** A pending local load cannot establish that every illustration is available. */
export function imageRetryStatus(result, images) {
  if (result.failed || result.saved) return imageResult(result);
  const missing = [...images].filter(img => img.complete && img.naturalWidth === 0).length;
  if (missing) return `${missing} image${missing === 1 ? '' : 's'} unavailable · no downloadable source found`;
  if ([...images].some(img => !img.complete)) return 'Images are still loading · retry once they finish';
  return 'No missing images in this chapter';
}
