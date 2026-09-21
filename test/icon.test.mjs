import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * The picture in a PNG, rather than the bytes of one.
 *
 * Comparing files byte for byte compares the compressor as much as the
 * drawing: zlib does not promise the same output across versions, so a test
 * written that way fails on a machine whose Node is a release ahead. What has
 * to be the same is the pixels.
 */
function pixels(png) {
  let at = 8;
  let width = 0;
  const parts = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    if (type === 'IHDR') width = png.readUInt32BE(at + 8);
    if (type === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  // written with no filter, so a row is its bytes with the filter byte dropped
  const stride = width * 3;
  const out = Buffer.alloc(raw.length - raw.length / (stride + 1));
  for (let row = 0; row * (stride + 1) < raw.length; row++) {
    raw.copy(out, row * stride, row * (stride + 1) + 1,
      (row + 1) * (stride + 1));
  }
  return out;
}

const res = (p) => fileURLToPath(new URL(`../android/res/${p}`, import.meta.url));

/**
 * The icon on the launcher is the icon in the repository.
 *
 * There is a vector, and on Android 8 and after that is what is shown. Before
 * that — and in some launchers' recents and some installers since — what is
 * shown is the PNG, and every one of those was the same 192px white rectangle:
 * a placeholder that had outlived the design it stood in for. They are drawn
 * from the same shapes now, and this runs the drawing and fails if what is
 * committed has drifted from it.
 */
test('the launcher icon is drawn from the shapes it is drawn from', () => {
  const before = new Map();
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const at = res(`mipmap-${density}/${name}`);
      before.set(at, readFileSync(at));
    }
  }

  execFileSync(process.execPath,
    [fileURLToPath(new URL('../tools/make-icon.mjs', import.meta.url))]);

  for (const [at, was] of before) {
    assert.deepEqual(pixels(readFileSync(at)), pixels(was),
      `run \`node tools/make-icon.mjs\` — ${at.split('/').slice(-2).join('/')} has drifted`);
  }
});

/** Each density gets the size it asks for, not one file copied five ways. */
test('a density is a size, not a name', () => {
  const want = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [density, size] of Object.entries(want)) {
    const png = readFileSync(res(`mipmap-${density}/ic_launcher.png`));
    assert.equal(png.readUInt32BE(16), size, `${density} is ${size}px across`);
    assert.equal(png.readUInt32BE(20), size, `${density} is ${size}px down`);
  }
});

test('a launcher that wants a round one is given a round one', () => {
  const manifest = readFileSync(
    fileURLToPath(new URL('../android/AndroidManifest.xml', import.meta.url)), 'utf8');
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/,
    'pointing it at the square one is the same as not having one');

  for (const density of readdirSync(res('.')).filter((d) => d.startsWith('mipmap-'))) {
    if (density.endsWith('-v26')) continue;
    const files = readdirSync(res(density));
    assert.ok(files.includes('ic_launcher_round.png'), `${density} has one`);
  }
});

/**
 * The mark is the same in both, which is the whole reason to draw rather than
 * export: two pictures of the same thing drift, and the one nobody looks at
 * drifts first.
 */
test('native and web icons are generated from the same source as the pixels', () => {
  const paths = [res('drawable/ic_launcher_foreground.xml'), res('values/ic_launcher_background.xml'),
    fileURLToPath(new URL('../app/folio-mark.svg', import.meta.url))];
  const before = paths.map(p => readFileSync(p, 'utf8'));
  execFileSync(process.execPath, [fileURLToPath(new URL('../tools/make-icon.mjs', import.meta.url))]);
  paths.forEach((p, i) => assert.equal(readFileSync(p, 'utf8'), before[i], `regenerate ${p}`));
});
