/**
 * Just enough ZIP to read an EPUB.
 *
 * EPUBs are ZIP files, and both places this code runs can already inflate:
 * the browser has DecompressionStream, node has zlib. Neither offers a ZIP
 * *container* reader, so that part is here. No dependency, because this has
 * to build on the phone with nothing installed.
 *
 * Zip64 is not handled. AO3 EPUBs are a few megabytes with a few dozen
 * entries, nowhere near the 4GB/65535-entry limits that trigger it, and a
 * silent misparse would be worse than an honest failure — so it throws.
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { inflateRawSync } = await import('node:zlib');
  return new Uint8Array(inflateRawSync(bytes));
}

/** Find the end-of-central-directory record, which is last but variable length. */
function findEocd(view, len) {
  // the comment field can be up to 65535 bytes, so that plus the 22-byte
  // record is as far back as it can possibly be
  const earliest = Math.max(0, len - 22 - 0xffff);
  for (let i = len - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

/**
 * Read every entry into memory, keyed by path.
 *
 * Whole-file is the right call here: an EPUB is small, and the alternative
 * (lazy per-entry reads) buys nothing when the caller wants the spine anyway.
 */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.byteLength);

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('zip64 is not supported');

  const files = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CD_SIG) throw new Error('corrupt central directory');
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // the central directory's extra field and the local header's are different
    // lengths, so the data offset has to come from the local header
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataAt = localOffset + 30 + localNameLen + localExtraLen;

    files.set(name, { method, data: bytes.subarray(dataAt, dataAt + compressedSize) });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // inflate lazily-but-eagerly: directories are empty, everything else unpacks
  const out = new Map();
  for (const [name, entry] of files) {
    if (name.endsWith('/')) continue;
    if (entry.method === 0) out.set(name, entry.data);
    else if (entry.method === 8) out.set(name, await inflateRaw(entry.data));
    else throw new Error(`unsupported compression method ${entry.method} for ${name}`);
  }
  return out;
}
