import assert from 'node:assert/strict';
import { startApp, addWork } from './harness.mjs';

const app = await startApp({ port: 18774, seed(db) {
  addWork(db, { id: 1, title: 'The long way home', chapters: 2 });
  // Already begun, so the page offers Start again as well as Mark finished.
  db.prepare(`INSERT INTO reading (work_id,chapter,offset,chapters_read,chapter_count,updated_at,opened_at) VALUES ('1',1,0,0,2,'2026-11-01','2026-11-01')`).run();
  // Paragraphs that can be told apart, and long enough to wrap differently at another size.
  const html = Array.from({ length: 120 }, (_, i) =>
    `<p>Paragraph ${i + 1}. The harbour was quiet that morning and the gulls had not yet come in from the sea, so nothing moved.</p>`).join('');
  db.prepare('UPDATE chapters SET html=? WHERE work_id=? AND number=1').run(html, '1');
} });
const { page, base, errors } = app;
const topParagraph = () => page.evaluate(() => {
  for (const p of document.querySelectorAll('#workskin .userstuff > *')) {
    if (p.getBoundingClientRect().bottom > 0) return p.textContent.match(/Paragraph (\d+)/)?.[1];
  }
  return null;
});
try {
  await page.goto(base + '/');
  await page.waitForSelector('#shelves > *');
  await page.click('#tabs [data-tab=library]');
  await page.locator('#works .work-title-link').first().click();
  await page.locator('#preview-story .work-title').waitFor();

  // The work page: one full-width thing to do, the rest as quiet links on one line.
  const layout = await page.evaluate(() => {
    const actions = document.querySelector('#preview-story .actions');
    const primary = actions.querySelector('.primary').getBoundingClientRect();
    const others = [...actions.querySelectorAll('button:not(.primary)')];
    return {
      primaryFills: primary.width >= actions.getBoundingClientRect().width - 2,
      rows: new Set(others.map(b => Math.round(b.getBoundingClientRect().top))).size,
      bordered: others.some(b => parseFloat(getComputedStyle(b).borderTopWidth) > 0),
      below: others.every(b => b.getBoundingClientRect().top >= primary.bottom),
    };
  });
  assert.deepEqual(layout, { primaryFills: true, rows: 1, bordered: false, below: true });
  assert.deepEqual(await page.locator('#preview-story .work-head .actions button').allInnerTexts(), ['Resume', 'Start again', 'Mark finished']);
  assert.equal(await page.locator('#preview-story .archive-upkeep button').filter({ hasText: 'Earlier versions' }).count(), 1);
  assert.equal(await page.locator('#preview-return').isVisible(), false, 'one way back on a phone');

  // Read some way into the chapter.
  await page.locator('#preview-story .actions .primary').click();
  await page.waitForSelector('#workskin .userstuff');
  await page.evaluate(() => {
    const p = document.querySelectorAll('#workskin .userstuff > *')[57];
    window.scrollTo(0, window.scrollY + p.getBoundingClientRect().top + 10);
  });
  await page.waitForTimeout(700);     // the place is saved a moment after the scroll stops
  assert.equal(await topParagraph(), '58');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('archive.positions') ?? 'null')
    ?? Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
  assert.equal(saved['1']?.block?.index, 57, 'the paragraph is what is remembered');
  const yBefore = await page.evaluate(() => window.scrollY);

  // Come back another day with much larger text: same paragraph, different pixel.
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('archive.prefs') ?? '{}');
    localStorage.setItem('archive.prefs', JSON.stringify({ ...prefs, size: 26 }));
  });
  await page.reload();
  await page.waitForSelector('#shelves > *');
  await page.locator('.resume-card .resume-action').first().click();
  await page.waitForSelector('#workskin .userstuff');
  await page.waitForFunction(() => window.scrollY > 0);
  await page.waitForTimeout(400);
  assert.equal(await topParagraph(), '58', 'opens at the same paragraph');
  const yAfter = await page.evaluate(() => window.scrollY);
  assert.ok(Math.abs(yAfter - yBefore) > 200, `the pixel offset alone would have been wrong (${yBefore} then ${yAfter})`);

  // Above the first paragraph there is no place in the text; the offset is kept and used.
  await page.evaluate(() => window.scrollTo(0, 60));
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('archive.positions'))['1'].block), null);
  await page.reload();
  await page.waitForSelector('#shelves > *');
  await page.locator('.resume-card .resume-action').first().click();
  await page.waitForSelector('#workskin .userstuff');
  await page.waitForFunction(() => Math.abs(window.scrollY - 60) < 3);

  // A place saved before this version has only an offset, and still opens by it.
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => /position/.test(k));
    const all = JSON.parse(localStorage.getItem(key));
    all['1'] = { chapter: 1, y: 900 };
    localStorage.setItem(key, JSON.stringify(all));
  });
  await page.reload();
  await page.waitForSelector('#shelves > *');
  await page.locator('.resume-card .resume-action').first().click();
  await page.waitForSelector('#workskin .userstuff');
  await page.waitForFunction(() => Math.abs(window.scrollY - 900) < 3);

  assert.deepEqual(errors, []);
  console.log('Work page actions and place in the text passed');
} finally {
  await app.close();
}
