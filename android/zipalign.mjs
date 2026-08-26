/**
 * Minimal zipalign. Android requires STORED entries (notably resources.arsc on
 * API 30+) to begin on a 4-byte boundary so they can be mmap'd; the platform
 * refuses to install an APK where that is not true. Rewrites the archive,
 * copying every entry's bytes verbatim and padding the local extra field so
 * stored data lands on the boundary.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ALIGN = 4;
const SIG_LOCAL = 0x04034b50, SIG_CEN = 0x02014b50, SIG_EOCD = 0x06054b50;

const [, , inPath, outPath] = process.argv;
const buf = readFileSync(inPath);

// --- locate end of central directory ---
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
  if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
}
if (eocd < 0) throw new Error('not a zip: no end-of-central-directory');
const count = buf.readUInt16LE(eocd + 10);
let cenOff = buf.readUInt32LE(eocd + 16);

// --- read central directory ---
const entries = [];
for (let i = 0, p = cenOff; i < count; i++) {
  if (buf.readUInt32LE(p) !== SIG_CEN) throw new Error('bad central directory at ' + p);
  const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30),
        cmtLen = buf.readUInt16LE(p + 32);
  entries.push({
    versionMade: buf.readUInt16LE(p + 4), versionNeed: buf.readUInt16LE(p + 6),
    flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10),
    time: buf.readUInt16LE(p + 12), date: buf.readUInt16LE(p + 14),
    crc: buf.readUInt32LE(p + 16), csize: buf.readUInt32LE(p + 20),
    usize: buf.readUInt32LE(p + 24), attrsInt: buf.readUInt16LE(p + 36),
    attrsExt: buf.readUInt32LE(p + 38), localOff: buf.readUInt32LE(p + 42),
    name: buf.subarray(p + 46, p + 46 + nameLen),
    comment: buf.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + cmtLen)
  });
  p += 46 + nameLen + extraLen + cmtLen;
}

// --- rewrite, aligning stored entries ---
const out = [];
let pos = 0;
const push = (b) => { out.push(b); pos += b.length; };

for (const e of entries) {
  const lp = e.localOff;
  if (buf.readUInt32LE(lp) !== SIG_LOCAL) throw new Error('bad local header for ' + e.name);
  const lNameLen = buf.readUInt16LE(lp + 26), lExtraLen = buf.readUInt16LE(lp + 28);
  const dataStart = lp + 30 + lNameLen + lExtraLen;
  const data = buf.subarray(dataStart, dataStart + e.csize);

  // pad the extra field so stored data starts aligned
  let extra = Buffer.alloc(0);
  if (e.method === 0) {
    const headerEnd = pos + 30 + e.name.length;
    const pad = (ALIGN - (headerEnd % ALIGN)) % ALIGN;
    if (pad) extra = Buffer.alloc(pad);          // zero-filled padding
  }

  e.newOff = pos;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(SIG_LOCAL, 0); lh.writeUInt16LE(e.versionNeed, 4);
  lh.writeUInt16LE(e.flags, 6); lh.writeUInt16LE(e.method, 8);
  lh.writeUInt16LE(e.time, 10); lh.writeUInt16LE(e.date, 12);
  lh.writeUInt32LE(e.crc, 14); lh.writeUInt32LE(e.csize, 18);
  lh.writeUInt32LE(e.usize, 22); lh.writeUInt16LE(e.name.length, 26);
  lh.writeUInt16LE(extra.length, 28);
  push(lh); push(e.name); push(extra); push(data);

  if (e.method === 0 && (e.newOff + 30 + e.name.length + extra.length) % ALIGN !== 0)
    throw new Error('alignment failed for ' + e.name);
}

const cenStart = pos;
for (const e of entries) {
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(SIG_CEN, 0); ch.writeUInt16LE(e.versionMade, 4);
  ch.writeUInt16LE(e.versionNeed, 6); ch.writeUInt16LE(e.flags, 8);
  ch.writeUInt16LE(e.method, 10); ch.writeUInt16LE(e.time, 12);
  ch.writeUInt16LE(e.date, 14); ch.writeUInt32LE(e.crc, 16);
  ch.writeUInt32LE(e.csize, 20); ch.writeUInt32LE(e.usize, 24);
  ch.writeUInt16LE(e.name.length, 28); ch.writeUInt16LE(0, 30);
  ch.writeUInt16LE(e.comment.length, 32); ch.writeUInt16LE(0, 34);
  ch.writeUInt16LE(e.attrsInt, 36); ch.writeUInt32LE(e.attrsExt, 38);
  ch.writeUInt32LE(e.newOff, 42);
  push(ch); push(e.name); push(e.comment);
}

const end = Buffer.alloc(22);
end.writeUInt32LE(SIG_EOCD, 0);
end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(pos - cenStart, 12); end.writeUInt32LE(cenStart, 16);
push(end);

writeFileSync(outPath, Buffer.concat(out));
const stored = entries.filter(e => e.method === 0);
console.log(`     aligned ${entries.length} entries (${stored.length} stored) -> ${pos} bytes`);
