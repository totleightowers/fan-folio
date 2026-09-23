/** History snapshots are stored a page at a time; replaying a page is safe. */
export async function walkHistory({ fetchPage, savePage, waitUntilRunnable, fromPage = 1, onProgress = () => {} }) {
  let checked = 0, total = null;
  for (let page = Math.max(1, fromPage); ; page++) {
    if (!await waitUntilRunnable()) return { complete: false, checked };
    const listing = await fetchPage(page);
    total = listing.pagination?.total ?? total ?? page;
    if (!await waitUntilRunnable()) return { complete: false, checked };
    checked += await savePage(listing.works);
    onProgress({ page, pages: total, checked });
    if (page >= total) return { complete: true, checked };
  }
}
