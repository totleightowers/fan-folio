import assert from 'node:assert/strict';
import { startApp, addWork } from './harness.mjs';

// A tablet held upright: narrower than the old breakpoint at which the list disappeared.
const app = await startApp({ port: 18776, viewport: { width: 800, height: 1280 }, mobile: false, seed(db) {
  addWork(db, { id: 1, title: 'Apple orchard', chapters: 2, words: 9000 });
  addWork(db, { id: 2, title: 'Zebra crossing', chapters: 2, words: 500 });
  addWork(db, { id: 3, title: 'Middle distance', chapters: 2, words: 4000, held: false });
  const read = db.prepare(`INSERT INTO reading (work_id,chapter,offset,chapters_read,chapter_count,updated_at,opened_at) VALUES (?,?,0,1,2,?,?)`);
  read.run('1', 2, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z');
  read.run('2', 2, '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z');
} });
const { page, base, errors } = app;
const listed = () => page.locator('#preview-list .preview-choice strong').allInnerTexts();
const settles = (expected) => page.waitForFunction((want) =>
  JSON.stringify([...document.querySelectorAll('#preview-list .preview-choice strong')].map(n => n.textContent)) === JSON.stringify(want),
  expected, { timeout: 8000 });
try {
  await page.goto(base + '/');
  await page.waitForSelector('#shelves > *');
  await page.click('#tabs [data-tab=library]');
  await page.locator('#works .work-title-link').filter({ hasText: 'Apple orchard' }).click();
  await page.locator('#preview-story .work-title').filter({ hasText: 'Apple orchard' }).waitFor();

  // The list stays beside the story, with the story given most of the width.
  await page.locator('#preview-library').waitFor({ state: 'visible' });
  const shape = await page.evaluate(() => {
    const list = document.querySelector('#preview-library').getBoundingClientRect();
    const story = document.querySelector('#preview-story').getBoundingClientRect();
    return { beside: list.right <= story.left + 1, storyWider: story.width > list.width, fits: document.documentElement.scrollWidth <= innerWidth + 1 };
  });
  assert.deepEqual(shape, { beside: true, storyWider: true, fits: true });
  assert.deepEqual(await listed(), ['Apple orchard', 'Middle distance', 'Zebra crossing']);
  assert.equal(await page.locator('#preview-collection').inputValue(), 'all');
  assert.equal(await page.locator('#preview-sort').inputValue(), 'title');

  // Another order, without leaving the story.
  await page.locator('#preview-sort').selectOption('words');
  await settles(['Apple orchard', 'Middle distance', 'Zebra crossing']);
  await page.locator('#preview-sort').selectOption('shortest');
  await settles(['Zebra crossing', 'Middle distance', 'Apple orchard']);
  await page.locator('#preview-story .work-title').filter({ hasText: 'Apple orchard' }).waitFor();
  assert.equal(await page.locator('#preview-list [aria-current]').innerText().then(t => /Apple orchard/.test(t)), true, 'the story on screen is still marked');

  // Another collection: what is being read, most recent first.
  await page.locator('#preview-collection').selectOption('reading');
  await settles(['Zebra crossing', 'Apple orchard']);
  assert.match(await page.locator('#preview-count').innerText(), /^2 works$/);
  assert.equal(await page.locator('#preview-sort').inputValue(), 'recent');

  // Filters open from here and apply to this list.
  await page.locator('#preview-collection').selectOption('all');
  await settles(['Zebra crossing', 'Middle distance', 'Apple orchard']);
  await page.click('#preview-filters');
  await page.locator('#filters').waitFor({ state: 'visible' });
  await page.locator('#availability').selectOption('known');
  await page.click('#apply-filters');
  await page.locator('#filters').waitFor({ state: 'hidden' });
  await settles(['Middle distance']);
  assert.equal(await page.locator('#preview-filter-count').innerText(), '1');

  // Choosing from the list changes the story, and Back is still one step to the Library —
  // which is found asking the same question the list was.
  await page.locator('#preview-list .preview-choice').filter({ hasText: 'Middle distance' }).click();
  await page.locator('#preview-story .work-title').filter({ hasText: 'Middle distance' }).waitFor();
  await page.locator('#back').click();
  await page.locator('#library').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 1);
  assert.equal(await page.locator('#works .work-card h3').innerText(), 'Middle distance');
  assert.equal(await page.locator('#sort').inputValue(), 'shortest');
  assert.equal(await page.locator('#availability').inputValue(), 'known');

  // Wide, as well as upright.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('#works .work-title-link').first().click();
  await page.locator('#preview-library').waitFor({ state: 'visible' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

  // And on a phone there is no room for it, so it is not there.
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#preview-library').isVisible(), false);

  assert.deepEqual(errors, []);
  console.log('Tablet list beside the story passed');
} finally {
  await app.close();
}
