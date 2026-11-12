/**
 * A whole theme from the two colours a reader chose.
 *
 * A custom theme used to set the page and the text and nothing else, while
 * every card, sheet, bar and field took its colour from the theme the phone
 * happened to be in. White text chosen for a black page then landed on white
 * cards. Every ground and every weight of ink is derived here from the same
 * two colours, so there is no surface a custom theme does not reach.
 */

function parse(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''))
    ?? /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(String(hex ?? ''));
  if (!m) return null;
  const full = m.length === 2 ? m[1] : m.slice(1).map((c) => c + c).join('');
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

/** `amount` of `b` stirred into `a`. */
function mix(a, b, amount) {
  return toHex(a.map((c, i) => c + (b[i] - c) * amount));
}

/** Perceived lightness, by the usual luminance weights. */
export function isDark(hex) {
  const rgb = parse(hex);
  if (!rgb) return false;
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) < 128;
}

/** Every token a theme states, for a background and a text colour. */
export function customTheme(bg, fg) {
  const paper = parse(bg);
  const ink = parse(fg);
  if (!paper || !ink) return null;
  const dark = isDark(bg);
  return {
    'color-scheme': dark ? 'dark' : 'light',
    '--paper': toHex(paper),
    '--surface': mix(paper, ink, 0.06),
    '--sunken': mix(paper, ink, 0.11),
    '--line': mix(paper, ink, 0.2),
    '--line-soft': mix(paper, ink, 0.13),
    '--ink': toHex(ink),
    '--ink-mid': mix(ink, paper, 0.18),
    '--ink-mute': mix(ink, paper, 0.26),
    '--ink-faint': mix(ink, paper, 0.42),
    // an accent and a link that stay legible against whichever ground was chosen
    '--accent': dark ? '#b3d4b7' : '#315e50',
    '--on-accent': dark ? '#18281d' : '#ffffff',
    '--link': dark ? '#7fb2ef' : '#1f5fa9',
    '--no': dark ? '#e07a6e' : '#c0392b',
    '--press': dark ? 'rgb(255 255 255 / .11)' : 'rgb(0 0 0 / .10)',
  };
}

export const CUSTOM_THEME_TOKENS = Object.keys(customTheme('#000000', '#ffffff'));
