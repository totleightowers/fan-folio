import assert from 'node:assert/strict';
import { startApp, addWork } from './harness.mjs';

const LONG = 'Pneumonoultramicroscopicsilicovolcanoconiosis_and_the_unbrokenly_long_title_that_never_once_stops_for_breath';
const app = await startApp({ port: 18771, seed(db) {
  addWork(db, { id: 1, title: LONG, chapters: 2, relationships: ['A/B'] });
  addWork(db, { id: 2, title: 'A little light in the afternoon' });
} });
const { page, base, errors } = app;
try {
  // White on black, as imported from Archive Reader.
  await page.addInitScript(() => {
    if (!localStorage.getItem('archive.prefs')) {
      localStorage.setItem('archive.prefs', JSON.stringify({ theme: 'custom', bg: '#000000', fg: '#ffffff' }));
    }
  });
  await page.goto(base + '/');
  await page.waitForSelector('#shelves > *');

  const luminance = (selector) => page.locator(selector).first().evaluate((el) => {
    const read = (value) => { const m = /rgba?\(([^)]+)\)/.exec(value); return m ? m[1].split(/[ ,/]+/).map(Number) : null; };
    let node = el; let bg = null;
    // the first ancestor that actually paints a background
    while (node && (!bg || bg[3] === 0)) { bg = read(getComputedStyle(node).backgroundColor); if (bg && bg.length === 3) bg.push(1); node = node.parentElement; }
    const fg = read(getComputedStyle(el).color);
    const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return { bg: lum(bg), fg: lum(fg) };
  });
  const readable = async (selector) => {
    const { bg, fg } = await luminance(selector);
    assert.ok(bg < 0.25, `${selector} sits on a dark ground (${bg.toFixed(2)})`);
    assert.ok(fg - bg > 0.45, `${selector} text stands out from its ground (${fg.toFixed(2)} on ${bg.toFixed(2)})`);
  };

  await readable('#shelves .card .card-title');
  await readable('#tabs [data-tab=library]');
  await page.click('#tabs [data-tab=library]');
  await page.waitForSelector('#works .work-card');
  await readable('#works .work-card h3');
  await readable('#works .work-card .sum');
  await page.click('#open-filters');
  await page.locator('#filters').waitFor({ state: 'visible' });
  await readable('#filters h2');
  await readable('#sort');
  await page.click('#apply-filters');
  await page.locator('#filters').waitFor({ state: 'hidden' });

  // A title with nowhere to break still fits the screen, on the work page and in the reader.
  const fits = (selector) => page.locator(selector).first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1
      && document.documentElement.scrollWidth <= innerWidth + 1;
  });
  await page.locator('#works .work-title-link').filter({ hasText: 'Pneumono' }).click();
  await page.locator('#preview-story .work-title').waitFor();
  await readable('#preview-story .work-title');
  assert.ok(await fits('#preview-story .work-title'), 'the work page title wraps inside the screen');
  assert.ok((await page.locator('#preview-story .work-title').innerText()).includes('never_once_stops_for_breath'), 'none of it is cut off');
  await page.locator('#preview-story .actions .primary').click();
  await page.waitForSelector('#workskin .userstuff');
  assert.ok(await fits('#rh-title'), 'the reader title wraps inside the screen');
  await readable('#workskin .userstuff p');

  assert.deepEqual(errors, []);
  console.log('Custom colours on every surface and long titles passed');
} finally {
  await app.close();
}
