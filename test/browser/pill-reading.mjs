import assert from 'node:assert/strict';
import { startApp, addWork } from './harness.mjs';

const app = await startApp({ port: 18773, seed(db) {
  addWork(db, { id: 1, title: 'Apple orchard', chapters: 3, summary: 'A long summary. '.repeat(120) });
  addWork(db, { id: 2, title: 'Zebra crossing', chapters: 3 });
  addWork(db, { id: 3, title: 'Middle distance', chapters: 3 });
  // Zebra was read most recently, Apple before it; Middle distance never.
  const read = db.prepare(`INSERT INTO reading (work_id,chapter,offset,chapters_read,chapter_count,updated_at,opened_at) VALUES (?,?,0,1,3,?,?)`);
  read.run('1', 2, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z');
  read.run('2', 2, '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z');
} });
const { page, base, errors } = app;
const titles = () => page.locator('#works .work-card h3').allInnerTexts();
try {
  await page.goto(base + '/');
  await page.waitForSelector('#shelves > *');
  // Home says each shelf's size once, and a card's visits as one number.
  assert.deepEqual([...new Set(await page.locator('.shelf-head button').allInnerTexts())], ['See all']);
  await page.click('#tabs [data-tab=library]');
  await page.waitForSelector('#works .work-card');
  assert.deepEqual(await titles(), ['Apple orchard', 'Middle distance', 'Zebra crossing'], 'everything, by title');

  // A work found by searching the Library is the same flat row, and nobody is told how long it took.
  await page.click('#context-search');
  await page.fill('#q', 'Zebra');
  await page.locator('#results .work-card').first().waitFor();
  assert.equal(await page.locator('#results .work-card').first().evaluate(el => parseFloat(getComputedStyle(el).borderTopWidth)), 0);
  assert.doesNotMatch(await page.locator('#results .count').innerText(), /\dms/);
  assert.ok(await page.locator('#search-scope').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'the scope label fits');
  await page.locator('#back').click();
  await page.locator('#library').waitFor({ state: 'visible' });

  // Reading: most recently read first, and no pill or badge repeating the tab.
  await page.click('#library-collections [data-collection=reading]');
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 2);
  assert.deepEqual(await titles(), ['Zebra crossing', 'Apple orchard']);
  assert.equal(await page.locator('#sort').inputValue(), 'recent');
  assert.equal(await page.locator('#active .active-pill').count(), 0, 'the tab is not repeated as a filter pill');
  assert.equal(await page.locator('#filter-count').isVisible(), false, 'and is not counted as a filter');

  // A real filter on top of the tab is still shown and counted.
  await page.click('#open-filters');
  await page.locator('#availability').selectOption('held');
  await page.click('#apply-filters');
  await page.locator('#filters').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#active .active-pill').count(), 1);
  assert.equal(await page.locator('#filter-count').innerText(), '1');

  // Leaving Reading gives back the order chosen for everything else.
  await page.click('#library-collections [data-collection=all]');
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 3);
  assert.equal(await page.locator('#sort').inputValue(), 'title');
  assert.deepEqual(await titles(), ['Apple orchard', 'Middle distance', 'Zebra crossing']);

  // Start reading Zebra, then leave the reader: the pill offers the way back…
  await page.locator('#works .work-title-link').filter({ hasText: 'Zebra crossing' }).click();
  await page.locator('#preview-story .actions .primary').click();
  await page.waitForSelector('#workskin .userstuff');
  await page.locator('#back').click();
  await page.locator('#preview-story .work-title').filter({ hasText: 'Zebra crossing' }).waitFor();
  // …but not on that story's own page, which already has the button for it.
  assert.equal(await page.locator('#now-reading').isVisible(), false, 'no pill over the story it would return to');
  await page.locator('#back').click();
  await page.locator('#library').waitFor({ state: 'visible' });
  await page.locator('#now-reading').waitFor({ state: 'visible' });

  // On another story's page it shows, steps aside while reading down, and returns on the way up.
  await page.locator('#works .work-title-link').filter({ hasText: 'Apple orchard' }).click();
  await page.locator('#preview-story .work-title').filter({ hasText: 'Apple orchard' }).waitFor();
  await page.locator('#now-reading').waitFor({ state: 'visible' });
  const tucked = () => page.locator('#now-reading').evaluate((el) => el.classList.contains('tucked'));
  assert.equal(await tucked(), false);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction(() => document.querySelector('#now-reading').classList.contains('tucked'));
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(() => !document.querySelector('#now-reading').classList.contains('tucked'));
  await page.locator('#now-reading').click();
  await page.waitForSelector('#workskin .userstuff');
  assert.match(await page.locator('#rh-title').innerText(), /Zebra crossing/);

  assert.deepEqual(errors, []);
  console.log('Return pill and Reading collection passed');
} finally {
  await app.close();
}
