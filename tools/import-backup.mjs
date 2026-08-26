/**
 * Read an Archive Reader backup (.ao3) and carry its reader theme across.
 *
 * The backup is a zip of Hive boxes plus a plain user_settings.json. Only the
 * settings file is needed for the look of the reader; the boxes hold reading
 * positions and history, which are imported separately.
 *
 * Matching the theme by hand invites transcription errors in exactly the
 * values a reader would notice, so it is converted mechanically.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readZip } from '../app/core/zip.js';

const src = process.argv[2];
const out = process.argv[3] || 'data/prefs.json';
if (!src) { console.error('usage: node tools/import-backup.mjs <backup.ao3> [out.json]'); process.exit(1); }

/** Flutter stores colours as a signed 32-bit ARGB int. */
function argbToHex(value) {
  const n = Number(value) >>> 0;
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

const zip = await readZip(new Uint8Array(await readFile(src)));
const settingsRaw = zip.get('user_settings.json');
if (!settingsRaw) throw new Error('no user_settings.json in that backup');
const settings = JSON.parse(new TextDecoder().decode(settingsRaw));

const themes = settings.readerThemes ?? [];
const theme = themes[settings.currentTheme ?? 0];
if (!theme) throw new Error('the backup names no current reader theme');

const size = Math.round((theme.fontSize ?? 16) * (settings.textSizeCoefficient ?? 1));

/*
 * lineSpacing is stored in the same units as the margins — logical pixels
 * added between lines — so the CSS ratio is (size + spacing) / size. Flutter's
 * TextStyle.height is a multiplier, which this converts to.
 */
const lh = Math.round(((size + (theme.lineSpacing ?? 0)) / size) * 100);

const prefs = {
  theme: 'custom',
  bg: argbToHex(theme.backgroundColor),
  fg: argbToHex(theme.textColor),
  face: theme.fontName ?? 'Roboto',
  weight: /bold/i.test(theme.font ?? '') ? 600 : 400,
  size,
  lh,
  margin: theme.margin ?? 0,
  vmargin: theme.verticalMargin ?? 0,
  align: theme.textAlign === 'justify' ? 'justify' : 'start',
};

await mkdir('data', { recursive: true });
await writeFile(out, JSON.stringify({ importedFrom: src, theme: theme.name, prefs }, null, 1));

console.log(`imported "${theme.name}" (of ${themes.length} themes)`);
for (const [k, v] of Object.entries(prefs)) console.log(`  ${k.padEnd(8)} ${v}`);
console.log(`\nline spacing ${theme.lineSpacing} at size ${size} → line-height ${lh / 100}`);
console.log(`written to ${out}`);

// things worth knowing that are not part of the theme
const notable = ['readerShowStartNotes', 'readerShowEndNotes', 'readerShowChapterTitle',
  'readerShowChapterSummary', 'readerShowScrollbar', 'readerAutoscrollSpeed',
  'preventLockScreenInReader', 'openLastReadingAutomatically', 'hideFullyReadWorks',
  'totalReadHoursReached', 'lastWorkOpenedTitle'];
console.log('\nother reader behaviour in the backup:');
for (const k of notable) if (k in settings) console.log(`  ${k.padEnd(30)} ${settings[k]}`);
