/** The faces a reader can choose, and how each one is found. */
export const SYSTEM_FACES = {
  Georgia: "Georgia, 'Times New Roman', serif",
  System: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  Monospace: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};
/**
 * Faces that ship with the app, declared in fonts.css.
 *
 * An app whose whole point is a library that reads with no internet was asking
 * for the internet to change typeface: every family but the three the phone
 * already had was fetched from Google the first time it was chosen, so offline
 * the choice silently did nothing and the text stayed in the fallback. These
 * two are here already — a face made for long-form reading, and one drawn to
 * be legible to low vision, which is the one where needing a connection to
 * have it is least defensible.
 */
export const BUNDLED_FACES = new Set(['Literata', 'Atkinson Hyperlegible']);

const loadedFonts = new Set();

/**
 * Fonts come from Google Fonts, the way AO3 and Archive Reader both do, so any
 * family the reader names is reproducible. Only the font is fetched; every
 * word came from the archive on disk.
 */
export function loadGoogleFont(family, weight = 400) {
  if (!family || SYSTEM_FACES[family] || BUNDLED_FACES.has(family)) return;
  const key = `${family}:${weight}`;
  if (loadedFonts.has(key)) return;
  loadedFonts.add(key);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family='
    + encodeURIComponent(family).replace(/%20/g, '+') + ':wght@300;400;500;600&display=swap';
  link.onerror = () => loadedFonts.delete(key);      // offline: the fallback stands
  document.head.append(link);
}

export const faceStack = (family) => SYSTEM_FACES[family] ?? `'${String(family).replace(/'/g, '')}', Georgia, serif`;
