import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customTheme, isDark, CUSTOM_THEME_TOKENS } from '../app/core/theme.js';

const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('white on black reaches every surface, and stays readable on each', () => {
  const t = customTheme('#000000', '#ffffff');
  assert.equal(t['color-scheme'], 'dark');
  assert.equal(t['--paper'], '#000000');
  assert.equal(t['--ink'], '#ffffff');
  for (const ground of ['--paper', '--surface', '--sunken']) {
    assert.ok(isDark(t[ground]), `${ground} is a dark ground`);
    for (const ink of ['--ink', '--ink-mid', '--ink-mute']) {
      assert.ok(contrast(t[ink], t[ground]) >= 4.5, `${ink} on ${ground}`);
    }
    assert.ok(contrast(t['--accent'], t[ground]) >= 4.5, `accent on ${ground}`);
    assert.ok(contrast(t['--link'], t[ground]) >= 4.5, `link on ${ground}`);
  }
  assert.ok(contrast(t['--on-accent'], t['--accent']) >= 4.5);
});

test('a light custom theme is derived the same way', () => {
  const t = customTheme('#fdf6e3', '#222222');
  assert.equal(t['color-scheme'], 'light');
  for (const ground of ['--paper', '--surface', '--sunken']) {
    assert.ok(!isDark(t[ground]));
    assert.ok(contrast(t['--ink'], t[ground]) >= 7);
    assert.ok(contrast(t['--ink-mute'], t[ground]) >= 4.5);
    assert.ok(contrast(t['--accent'], t[ground]) >= 4.5);
  }
});

test('a colour that is not a colour gives no theme rather than a broken one', () => {
  assert.equal(customTheme('nope', '#fff'), null);
  assert.equal(customTheme('#000', '#fff')['--paper'], '#000000');
});

test('a custom theme states every token the built-in themes state', () => {
  const css = readFileSync(new URL('../app/styles.css', import.meta.url), 'utf8');
  const block = /:root\[data-theme='black'\] \{([\s\S]*?)\}/.exec(css)[1];
  const stated = [...block.matchAll(/(--[\w-]+|color-scheme)\s*:/g)].map((m) => m[1]);
  for (const token of stated) assert.ok(CUSTOM_THEME_TOKENS.includes(token), token);
});
