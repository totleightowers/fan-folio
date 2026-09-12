/**
 * The launcher icon, drawn rather than exported.
 *
 * There is a vector already — three pages fanning from a common corner, fan
 * and folio, without borrowing anyone's branding — and on Android 8 and after
 * that is what a launcher shows. Before that, and in a handful of places
 * since (some launchers' recents, some installers), what is shown is the PNG
 * in mipmap/, and every one of those was the same 192px white rectangle: a
 * placeholder that had outlived the design it was standing in for.
 *
 * Exporting them needs image tooling this project does not have and should
 * not acquire for five small squares, so they are rasterised here. The shapes
 * are the ones in ic_launcher_foreground.xml, kept in step by a test that
 * runs this and fails if what is committed has drifted.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

/* The canvas the adaptive icon is drawn on, so the two are the same picture. */
const CANVAS = 108;

const GROUND = [0x1a, 0x1c, 0x1e];
const PAGE = [0xff, 0xff, 0xff];
const INK = [0x8c, 0x3b, 0x2e];
const RIBBON = [0xd9, 0x8a, 0x72];

/** One page: a rounded rectangle, turned about the corner they fan from. */
const page = (turn, alpha) => ({
  kind: 'roundRect',
  x: 29, y: 30, w: 36, h: 52, r: 3,
  turn, pivot: [42, 76], colour: PAGE, alpha,
});

const SHAPES = [
  page(-26, 0.45),
  page(-13, 0.7),
  page(0, 1),
  // the lines of text on the front page
  { kind: 'rect', x: 37, y: 42, w: 20, h: 3, colour: INK, alpha: 1 },
  { kind: 'rect', x: 37, y: 51, w: 20, h: 3, colour: INK, alpha: 1 },
  { kind: 'rect', x: 37, y: 60, w: 13, h: 3, colour: INK, alpha: 1 },
  // the bookmark: the one detail that survives at 48 pixels
  {
    kind: 'polygon',
    points: [[68, 26], [78, 26], [78, 52], [73, 47], [68, 52]],
    colour: RIBBON,
    alpha: 1,
  },
];

/** Is this point inside the shape, in canvas units? */
function covers(shape, px, py) {
  let x = px;
  let y = py;
  if (shape.turn) {
    /* Turned about the pivot, so the test asks the untumed shape about a
       turned point rather than the other way round. */
    const a = (-shape.turn * Math.PI) / 180;
    const [cx, cy] = shape.pivot;
    const dx = px - cx;
    const dy = py - cy;
    x = cx + dx * Math.cos(a) - dy * Math.sin(a);
    y = cy + dx * Math.sin(a) + dy * Math.cos(a);
  }

  if (shape.kind === 'rect' || shape.kind === 'roundRect') {
    const { x: rx, y: ry, w, h } = shape;
    if (x < rx || x > rx + w || y < ry || y > ry + h) return false;
    const r = shape.r ?? 0;
    if (!r) return true;
    // only the corners can be outside a rounded rectangle
    const nx = x < rx + r ? rx + r : (x > rx + w - r ? rx + w - r : x);
    const ny = y < ry + r ? ry + r : (y > ry + h - r ? ry + h - r : y);
    return (x - nx) ** 2 + (y - ny) ** 2 <= r * r;
  }

  // a polygon, by the even-odd rule
  const pts = shape.points;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Four samples across and four down per pixel.
 *
 * An icon is mostly edges — three turned pages and a notched ribbon — and at
 * 48 pixels an unsampled edge is a staircase. Sixteen samples is enough that
 * the stairs disappear and cheap enough that five sizes render instantly.
 */
const GRID = 4;

function draw(size, { round = false } = {}) {
  const px = new Uint8Array(size * size * 3);
  const scale = CANVAS / size;
  const mid = (size - 1) / 2;
  const radius = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b] = GROUND;

      for (const shape of SHAPES) {
        let hits = 0;
        for (let sy = 0; sy < GRID; sy++) {
          for (let sx = 0; sx < GRID; sx++) {
            const cx = (x + (sx + 0.5) / GRID) * scale;
            const cy = (y + (sy + 0.5) / GRID) * scale;
            if (covers(shape, cx, cy)) hits++;
          }
        }
        if (!hits) continue;
        const a = (hits / (GRID * GRID)) * shape.alpha;
        r = Math.round(r * (1 - a) + shape.colour[0] * a);
        g = Math.round(g * (1 - a) + shape.colour[1] * a);
        b = Math.round(b * (1 - a) + shape.colour[2] * a);
      }

      /* The round variant is clipped rather than drawn differently, so the
         two cannot come out as different pictures. */
      if (round) {
        const d = Math.hypot(x - mid, y - mid);
        if (d > radius) { r = 0; g = 0; b = 0; }
      }

      const at = (y * size + x) * 3;
      px[at] = r;
      px[at + 1] = g;
      px[at + 2] = b;
    }
  }
  return px;
}

/* --------------------------------------------------------------- the file */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

function png(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // eight bits a channel
  ihdr[9] = 2;    // colour, no alpha: the ground is opaque
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;   // no filter; these compress well enough flat
    Buffer.from(px.subarray(y * stride, (y + 1) * stride))
      .copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** What each density actually asks for, rather than one size copied five ways. */
const DENSITIES = {
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};

let wrote = 0;
for (const [density, size] of Object.entries(DENSITIES)) {
  for (const [name, round] of [['ic_launcher', false], ['ic_launcher_round', true]]) {
    const at = new URL(`../android/res/mipmap-${density}/${name}.png`, import.meta.url);
    writeFileSync(at, png(size, draw(size, { round })));
    wrote++;
  }
}
process.stdout.write(`wrote ${wrote} icons\n`);
