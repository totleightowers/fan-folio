import assert from 'node:assert/strict';
import { startApp, addWork } from './harness.mjs';

const app = await startApp({ port: 18777, viewport: { width: 900, height: 1000 }, mobile: false, seed(db) {
  addWork(db, { id: 1, title: 'Apple orchard', words: 9000 });
  addWork(db, { id: 2, title: 'Middle distance', words: 4000, held: false });
  addWork(db, { id: 3, title: 'Zebra crossing', words: 500, fandom: 'Another world' });
} });
const { page, base, errors } = app;
const rows = () => page.locator('#works .work-title-link').allTextContents();
const expectRows = names => page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#works .work-title-link')].map(n => n.textContent)) === JSON.stringify(expected), names);
const expectPreview = names => page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#preview-choices strong')].map(n => n.textContent)) === JSON.stringify(expected), names);
const all = ['Apple orchard', 'Middle distance', 'Zebra crossing'];
const close = async () => { await page.locator('#filters [data-close]').click(); await page.locator('#filters').waitFor({state:'hidden'}); };
try {
  await page.goto(base);
  await page.click('#tabs [data-tab=library]');
  await expectRows(all);
  await page.click('#open-filters');
  await page.selectOption('#availability', 'held');
  await page.click('#apply-filters');
  await expectRows(['Apple orchard', 'Zebra crossing']);
  await page.click('#open-filters');
  await page.click('#clear-filters');
  assert.equal(await page.locator('#availability').inputValue(), '', 'Clear resets the visible availability selector');
  await expectRows(all); // Clear takes effect without a second Apply tap.
  await close();
  await page.reload();
  await page.click('#tabs [data-tab=library]');
  await expectRows(all);

  // Dismissing a sheet cannot save new filters while leaving old results visible.
  await page.click('#open-filters');
  await page.selectOption('#availability', 'known');
  await close();
  await expectRows(['Middle distance']);
  await page.locator('#works .tagpill').filter({hasText:'The Harbour'}).click();
  await expectRows(['Apple orchard', 'Middle distance']);
  assert.equal(await page.locator('#availability').inputValue(), '', 'a tag opens its own collection, not the previous availability filter');
  await page.click('#back');
  await expectRows(['Middle distance']);

  await page.click('#open-filters');
  await page.click('#clear-filters');
  await close();
  await page.locator('#works .work-title-link').first().click();
  await expectPreview(all);
  await page.click('#preview-filters');
  await page.selectOption('#availability', 'known');
  await page.click('#apply-filters');
  await expectPreview(['Middle distance']);
  await page.click('#preview-filters');
  await page.click('#clear-filters');
  await expectPreview(all);
  await close();
  assert.equal(await page.locator('#preview-filter-count').isVisible(), false);
  await page.click('#back');
  await expectRows(all);

  // Old count/facet responses must not undo Clear or disable Apply again.
  let release, arrived;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/works?*', async route => {
    const p = new URL(route.request().url()).searchParams;
    if (p.get('wordsMin') === '80000' && p.get('limit') === '1') {
      const response = await route.fetch(); arrived(); await held; await route.fulfill({response});
    } else await route.continue();
  });
  await page.click('#open-filters');
  const length = page.locator('.filter-section').filter({has:page.locator('.sec-title', {hasText:/^Length$/})});
  await length.locator('.sec-head').click();
  await length.getByRole('button', {name:'Over 80k', exact:true}).click();
  await requested;
  await page.click('#clear-filters');
  await page.locator('#apply-filters').filter({hasText:'Apply · 3'}).waitFor();
  release();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#apply-filters').isEnabled(), true);
  assert.equal(await page.locator('#apply-filters').innerText(), 'Apply · 3');
  await close();
  await page.unroute('**/api/works?*');

  // A tablet refill must discard earlier requests, even on the same collection object.
  await page.locator('#works .work-title-link').first().click();
  let releaseOld, oldArrived;
  const oldHeld = new Promise(resolve => { releaseOld = resolve; });
  const oldRequested = new Promise(resolve => { oldArrived = resolve; });
  await page.route('**/api/works?*', async route => {
    if (new URL(route.request().url()).searchParams.get('sort') === 'words') {
      const response = await route.fetch(); oldArrived(); await oldHeld; await route.fulfill({response});
    } else await route.continue();
  });
  await page.selectOption('#preview-sort', 'words');
  await oldRequested;
  await page.selectOption('#preview-sort', 'shortest');
  await expectPreview(['Zebra crossing', 'Middle distance', 'Apple orchard']);
  releaseOld();
  await page.waitForTimeout(300);
  await expectPreview(['Zebra crossing', 'Middle distance', 'Apple orchard']);
  assert.equal(await page.locator('#preview-count').innerText(), '3 works');
  await page.unroute('**/api/works?*');
  await page.locator('#preview-story [data-filter="tag"]').filter({hasText:'The Harbour'}).click();
  await expectRows(['Middle distance', 'Apple orchard']);
  await page.click('#back');
  await page.locator('#preview-library').waitFor({state:'visible'});
  await expectPreview(['Zebra crossing', 'Middle distance', 'Apple orchard']);
  assert.equal(await page.locator('#preview-filter-count').isVisible(), false, 'Back restores the preview filters as well as its rows');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('archive.view')).include), []);
  await page.click('#back');
  await expectRows(['Zebra crossing', 'Middle distance', 'Apple orchard']);
  assert.deepEqual(await rows(), ['Zebra crossing', 'Middle distance', 'Apple orchard']);
  await page.setViewportSize({width:390,height:844});
  await page.click('#open-filters');
  await page.selectOption('#availability', 'known');
  await page.click('#apply-filters');
  await expectRows(['Middle distance']);
  await page.click('#open-filters');
  await page.click('#clear-filters');
  await expectRows(['Zebra crossing', 'Middle distance', 'Apple orchard']);
  await close();
  assert.deepEqual(errors, []);
  console.log('Clear, dismissal, tag context and stale filter responses passed');
} finally { await app.close(); }
