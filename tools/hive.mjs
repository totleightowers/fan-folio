/**
 * Just enough of Hive's binary format to read an Archive Reader backup.
 *
 * Hive writes a log of frames: length, key, value, crc. Values are tagged, and
 * registered classes are written by generated adapters as a field count
 * followed by (index, value) pairs. Ints are stored as float64 — Hive does
 * that for web compatibility — so every number arrives as a double.
 *
 * Field *names* live in the app's Dart code and are not in the file, so this
 * returns numbered fields and leaves interpretation to the caller.
 */

const T = { NULL: 0, INT: 1, DOUBLE: 2, BOOL: 3, STRING: 4, BYTES: 5, INTS: 6, DOUBLES: 7, BOOLS: 8, STRINGS: 9, LIST: 10, MAP: 11 };

class Reader {
  constructor(bytes) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.i = 0; }
  u8() { return this.b[this.i++]; }
  u32() { const n = this.v.getUint32(this.i, true); this.i += 4; return n; }
  f64() { const n = this.v.getFloat64(this.i, true); this.i += 8; return n; }
  str(len) { this.need(len); const s = new TextDecoder().decode(this.b.subarray(this.i, this.i + len)); this.i += len; return s; }

  /**
   * A length read out of a misaligned frame is arbitrary, and acting on it
   * means allocating for a count that was never a count. One bad frame took
   * the whole import out of memory before this existed.
   */
  need(bytes) {
    const left = this.b.length - this.i;
    if (bytes < 0 || bytes > left) throw new Error(`length ${bytes} exceeds ${left} remaining`);
  }
  count(elementBytes) { const n = this.u32(); this.need(n * elementBytes); return n; }

  value(tag = this.u8()) {
    switch (tag) {
      case T.NULL: return null;
      case T.INT: return this.f64();
      case T.DOUBLE: return this.f64();
      case T.BOOL: return this.u8() !== 0;
      case T.STRING: return this.str(this.u32());
      case T.BYTES: { const n = this.count(1); const s = this.b.subarray(this.i, this.i + n); this.i += n; return s; }
      case T.INTS: case T.DOUBLES: { const n = this.count(8); return Array.from({ length: n }, () => this.f64()); }
      case T.BOOLS: { const n = this.count(1); return Array.from({ length: n }, () => this.u8() !== 0); }
      case T.STRINGS: { const n = this.count(4); return Array.from({ length: n }, () => this.str(this.u32())); }
      case T.LIST: { const n = this.count(1); const a = []; for (let k = 0; k < n; k++) a.push(this.value()); return a; }
      case T.MAP: { const n = this.count(2); const m = {}; for (let k = 0; k < n; k++) m[this.value()] = this.value(); return m; }
      default: {
        // >= 32 is a registered adapter: typeId + 32, then field count and pairs
        if (tag < 32) throw new Error(`unknown value tag ${tag}`);
        const typeId = tag - 32;
        const fields = this.u8();
        const obj = { __type: typeId };
        for (let f = 0; f < fields; f++) {
          const index = this.u8();
          // Archive Reader stores a field with a tag outside the documented
          // set. Everything needed — work id, chapter count, per-chapter scroll
          // offsets — comes before it, so an unreadable tail truncates the
          // record instead of throwing the whole thing away.
          try { obj[index] = this.value(); } catch { obj.__truncatedAt = index; break; }
        }
        return obj;
      }
    }
  }
}

export function readHive(bytes) {
  const out = new Map();
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  while (at + 4 <= bytes.length) {
    const len = v.getUint32(at, true);
    if (len < 8 || at + len > bytes.length) break;
    const frame = bytes.subarray(at + 4, at + len - 4);   // minus length and crc
    const r = new Reader(frame);
    try {
      const keyType = r.u8();
      const key = keyType === 0 ? r.u32() : r.str(r.u8());
      // a frame with nothing after the key is a deletion
      out.set(String(key), r.i < frame.length ? r.value() : null);
    } catch { /* a frame we cannot read must not stop the ones after it */ }
    at += len;
  }
  return out;
}
