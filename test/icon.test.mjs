import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    assert.deepEqual(readFileSync(at), was,
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
test('the vector and the pixels are the same picture', () => {
  const vector = readFileSync(res('drawable/ic_launcher_foreground.xml'), 'utf8');
  const drawn = readFileSync(
    fileURLToPath(new URL('../tools/make-icon.mjs', import.meta.url)), 'utf8');

  for (const shared of ['M32,30', 'M37,42', 'M68,26']) {
    assert.ok(vector.includes(shared), `${shared} is in the vector`);
  }
  for (const [inVector, inDrawing] of [
    ['#8C3B2E', '0x8c, 0x3b, 0x2e'],
    ['#D98A72', '0xd9, 0x8a, 0x72'],
  ]) {
    assert.ok(vector.includes(inVector) && drawn.includes(inDrawing),
      `${inVector} is the same colour in both`);
  }
  const ground = readFileSync(res('values/ic_launcher_background.xml'), 'utf8');
  assert.ok(ground.includes('#1A1C1E') && drawn.includes('0x1a, 0x1c, 0x1e'),
    'and they stand on the same ground');
});
