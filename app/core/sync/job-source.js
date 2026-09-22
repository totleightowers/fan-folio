/** Stable operation identity, including jobs saved before sources were explicit. */
export function jobSource(job) {
  const source = job.source;
  if (source?.kind === 'author' && source.author) return { kind: 'author', author: String(source.author), part: source.part === 'bookmarks' ? 'bookmarks' : 'works' };
  if (source?.kind === 'series' && /^\d+$/.test(String(source.seriesId))) return { kind: 'series', seriesId: String(source.seriesId) };
  if (['bookmarks-new', 'bookmarks-all', 'saved', 'epub', 'works'].includes(source?.kind)) return { kind: source.kind };
  if (job.author === 'Your bookmarks') return { kind: job.part === 'the whole list' ? 'bookmarks-all' : 'bookmarks-new' };
  if (job.author === 'Your library' && ['not downloaded', 'described but not held'].includes(job.part)) return { kind: 'saved' };
  if (job.author === 'Your EPUBs') return { kind: 'epub' };
  const series = String(job.author ?? '').match(/^Series (\d+)$/);
  if (series) return { kind: 'series', seriesId: series[1] };
  if (job.author && job.author !== 'null' && ['works', 'bookmarks'].includes(job.part)) return { kind: 'author', author: String(job.author), part: job.part };
  return { kind: 'works' };
}
