# Recovering hosted images

Fan Folio tries the original image first. For direct Imgur images only, a failed request or a recognised Imgur error image can fall back to `https://rimgo.nohost.network/<image-id>.<extension>`.

The switch is under **Settings → Reading comfort → Recover blocked Imgur images**. It is enabled by default. The proxy sees the image address and the requesting IP; no AO3 session, reading-page referrer or work text is sent. Only single image paths on `i.imgur.com`, `imgur.com` or `www.imgur.com` qualify. Query parameters and credentials are never forwarded to the proxy. Other hosts are fetched directly.

Images are fetched on Android's WebView request thread, one at a time, for the current chapter. Leaving the chapter stops subsequent requests. Redirects, sizes and timeouts are bounded. Successful responses are stored under the original image address with their original bytes, retaining animations. Reopening a saved image needs no upstream request.

**Reader → ⋯ → Retry missing images** retries this chapter immediately and makes failed images elsewhere in the work eligible on their next visit. Good stored copies are preserved. Failures otherwise cool down for a day; failures labelled `dead` by older versions get another chance. Two known Imgur error PNGs (the UK regional block and the removed-image placeholder) are rejected by SHA-256. Previously cached copies are removed when opening or importing a library, and by manual retry. Unknown future placeholder designs may need updated detection.

The proxy cannot restore an image deleted at its source and is a third-party service whose availability can change. Its errors remain retryable; HTML challenges and non-image responses are never stored as pictures.

## Validation

- A public Imgur sample returned the UK block directly and an actual PNG through the selected instance. No AO3 requests or user works were used in probing.
- The Java transport is exercised with deterministic connections and the real block/removed PNG fixtures, covering fallback, proxy opt-out, host restrictions, credential isolation, redirects, empty/oversized/non-image bodies and saved bytes.
- SQLite checks cover failure cooldowns and preserving good stored copies during retry.
- Collector tests cover duplicate starts, cancellation, chapter changes and stalled storage.
- A browser journey using the actual app and a simulated native bridge covers responsiveness during a pending request, failure → retry → displayed image, retained alt text, local-cache reopening and the persisted proxy switch. It makes no external requests.
- Android sources compile against API 34. Live endpoint probing succeeded with Python; a desktop Java network check could not connect from this workspace (`NoRouteToHostException`). The Java transport was exercised offline with deterministic connections. Behaviour on a physical Android device still needs confirmation.
