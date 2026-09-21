import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SCHEMA } from '../../app/core/store/schema.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'folio-ui-'));
const dbPath = join(dir, 'library.db');
const db = new DatabaseSync(dbPath);
db.exec(SCHEMA);
for (const [id, title, held] of [
  ['1', 'The long way home, and all the places we found along the way', 1],
  ['2', 'A little light in the afternoon', 0],
  ['epub-demo', 'Letters from the coast', 1],
]) {
  db.prepare(`INSERT INTO works (work_id,title,authors,summary,has_text,chapter_count,words,rating,complete,updated,downloaded_at)
    VALUES (?,?,?,?,?,1,3500,'General Audiences',1,'2026-09-01','2026-09-02')`)
    .run(id, title, '["Rowan"]', 'A missed train, an unexpected letter, and an afternoon that changes everything. Sometimes finding your way takes a little longer.', held);
  db.prepare('INSERT INTO tags (work_id,kind,name) VALUES (?,?,?)').run(id, 'fandom', 'The Harbour');
  if (held) db.prepare('INSERT INTO chapters (work_id,number,html,text,words) VALUES (?,1,?,?,3500)')
    .run(id, '<p>Afternoon light filled the room.</p>'.repeat(60), 'Afternoon light filled the room.');
}
db.exec("UPDATE works SET chapter_count=2 WHERE work_id='1'");
db.prepare('INSERT INTO chapters (work_id,number,title,html,text,words) VALUES (?,?,?,?,?,?)')
  .run('1', 2, 'Chapter 2: The way back', '<p>The harbour was quiet.</p>'.repeat(40), 'The harbour was quiet.', 1000);
db.prepare('INSERT INTO tags (work_id,kind,name) VALUES (?,?,?)')
  .run('1', 'relationship', 'Jeon Jungkook/Jung Hoseok | J-Hope/Kim Namjoon | RM/Min Yoongi | Suga/Park Jimin');
db.prepare('UPDATE works SET summary=? WHERE work_id=?')
  .run('A long description with several sentences that should wrap naturally within the card. '.repeat(12) + 'The final sentence stays visible.', '1');
db.close();
const server = spawn(process.execPath, [new URL('../../tools/serve.mjs', import.meta.url).pathname], {
  cwd: dir, env: { ...process.env, FANFOLIO_DB: dbPath, PORT: '18766' }, stdio: ['ignore', 'pipe', 'inherit'],
});
const browser = await chromium.launch();
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch('http://127.0.0.1:18766/api/home')).ok) break; } catch {}
    if (i === 50) throw new Error('UI server did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  mkdirSync('ui-screenshots', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const screenshot = async (name, { reading = false, fullPage = true } = {}) => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      window.scrollTo(0, 0);
    });
    if (reading) await page.locator('#typography').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `ui-screenshots/${name}.png`, fullPage });
  };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.route('**/api/prefs', route => route.fulfill({ json: { prefs: null } }));
  await page.goto('http://127.0.0.1:18766');
  await page.locator('#home').waitFor({ state: 'visible' });
  for (const width of [390, 900]) {
    await page.setViewportSize({ width, height: 940 });
    assert.ok(await page.evaluate(() => {
      const browse = document.querySelector('#fandoms').getBoundingClientRect();
      const shelves = document.querySelector('#shelves').getBoundingClientRect();
      return browse.bottom <= shelves.top && document.documentElement.scrollWidth <= innerWidth;
    }), 'fandom filters sit above shelves without horizontal page overflow');
    assert.equal(await page.locator('.browse-tab[data-kind="fandom"]').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('.fandom-list .name').first().evaluate(el => el.scrollWidth <= el.clientWidth), 'short fandom names remain fully readable');
    await screenshot('home-' + width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#open-settings').click();
  await page.locator('#reading-summary').filter({ hasText: 'Georgia' }).waitFor();
  await page.locator('#haptics').uncheck();
  await screenshot('settings-phone');
  await page.locator('#open-typo').click();
  await page.locator('[data-theme-choice="sepia"]').click();
  await page.locator('[data-face-choice="Literata"]').click();
  await page.locator('#size').focus();
  for (let i = 0; i < 5; i++) await page.locator('#size').press('ArrowRight');
  assert.equal(await page.locator('#size-value').textContent(), '24px');
  assert.equal(await page.locator('.sample').evaluate(el => getComputedStyle(el).fontSize), '24px');
  await screenshot('reading-phone', { reading: true, fullPage: false });
  await page.locator('#reset-reading').click();
  assert.equal(await page.locator('#size').inputValue(), '19');
  assert.equal(await page.locator('#haptics').isChecked(), false, 'reading reset preserves haptics');
  await page.locator('[data-theme-choice="dark"]').click();
  await page.locator('#typography [data-close]').first().click();
  await page.reload();
  await page.locator('#home').waitFor({ state: 'visible' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('[data-tab="library"]').click();
  await page.locator('.work-title-link').first().waitFor();
  assert.ok(await page.locator('#works .not-held').count());
  assert.equal(await page.locator('#works .work-card').filter({ hasText: 'Letters from the coast' }).locator('[data-act="ao3"]').count(), 0);
  for (const [width, height, name] of [[390,844,'phone'], [320,720,'narrow'], [582,1280,'large-phone'], [900,900,'tablet']]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
    assert.ok(await page.locator('#works .work-card').evaluateAll(cards => cards.every(card => {
      const box = card.getBoundingClientRect();
      const summary = card.querySelector('.sum');
      return box.left >= 0 && box.right <= innerWidth && card.scrollWidth <= card.clientWidth
        && (!summary || (summary.scrollWidth <= summary.clientWidth && summary.scrollHeight <= summary.clientHeight));
    })), 'long relationship tags cannot widen cards or clip descriptions');
    await screenshot(`library-${name}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#open-settings').click();
  await page.locator('#open-typo').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('[data-theme-choice="black"]').click();
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)', 'Black stays black when the system is dark');
  await page.locator('[data-theme-choice="light"]').click();
  assert.equal(await page.locator('html').getAttribute('data-dark'), null, 'Light overrides the system dark theme');
  await page.locator('[data-theme-choice="system"]').click();
  assert.equal(await page.locator('html').getAttribute('data-dark'), '');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dark'));
  await page.locator('[data-theme-choice="light"]').click();
  await page.locator('#typography [data-close]').first().click();
  await page.locator('#back').click();
  await screenshot('library-light');
  await page.locator('#works .work-card').filter({ hasText: 'The long way home' }).locator('[data-act="open"]').click();
  await page.locator('#reader-head').waitFor({ state: 'visible' });
  await screenshot('reader-phone', { fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 800));
  // Wait for the downward scroll to be handled before reversing direction.
  // Otherwise the browser can coalesce both scrolls and keep the bar hidden.
  await page.waitForFunction(() => document.querySelector('#chapnav').classList.contains('away'));
  await page.evaluate(() => window.scrollBy(0, -60));
  await page.waitForFunction(() => !document.querySelector('#chapnav').classList.contains('away'));
  await page.locator('#reader-type').click();
  assert.ok(await page.locator('#typography').evaluate(el => el.classList.contains('from-reader')));
  await page.locator('[data-face-choice="Literata"]').click();
  assert.ok((await page.locator('#workskin').evaluate(el => getComputedStyle(el).fontFamily)).includes('Literata'));
  await screenshot('reader-controls', { reading: true, fullPage: false });
  await page.locator('#typography [data-close]').first().click();
  await page.locator('#typography').waitFor({ state: 'hidden' });
  await page.locator('#read-next').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#next-title').textContent(), 'The way back');
  await page.screenshot({ path: 'ui-screenshots/reader-ending.png' });
  await page.locator('#read-next').click();
  await page.locator('#rh-chapter').filter({ hasText: 'Chapter 2' }).waitFor();
  assert.equal(await page.locator('#read-next').isVisible(), false);
  assert.equal(await page.locator('#chapter-ending-label').textContent(), 'You’ve reached the end');
  await page.locator('#ending-contents').click();
  await page.locator('#chapter-list button').first().click();
  await page.locator('#rh-chapter').filter({ hasText: 'Chapter 1' }).waitFor();
  await page.setViewportSize({ width: 320, height: 720 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'reader fits narrow phones');
  await screenshot('reader-narrow', { fullPage: false });
  await page.setViewportSize({ width: 900, height: 900 });
  for (const [width, height, name] of [[900, 940, 'portrait'], [1280, 800, 'landscape']]) {
    await page.setViewportSize({ width, height });
    const centred = await page.evaluate(() => {
      const bar = document.querySelector('#chapnav').getBoundingClientRect();
      const chapter = document.querySelector('#chappos').getBoundingClientRect();
      const navigation = document.querySelector('.reader-navigation').getBoundingClientRect();
      const tools = document.querySelector('.reader-tools').getBoundingClientRect();
      return Math.abs(chapter.x + chapter.width / 2 - bar.x - bar.width / 2) < 2
        && navigation.right <= tools.left && tools.right <= bar.right;
    });
    assert.ok(centred, 'chapter navigation stays centred without overlapping actions');
    await screenshot('reader-tablet-' + name, { fullPage: false });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !document.querySelector('#chapnav').classList.contains('away'));
  await page.locator('#reader-type').click();
  await page.locator('[data-theme-choice="dark"]').click();
  await page.locator('#typography [data-close]').first().click();
  await page.locator('#typography').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 900, height: 940 });
  await screenshot('reader-tablet-dark', { fullPage: false });
  assert.equal(await page.locator('#comment-here').isVisible(), true);
  assert.equal(await page.locator('#comment-here use').getAttribute('href'), '#i-comment');
  for (const id of ['kudos-here', 'bookmark-here', 'on-archive']) assert.equal(await page.locator('#' + id).isVisible(), false);
  await page.locator('#reader-more').click();
  for (const id of ['reader-kudos', 'reader-bookmark', 'reader-archive']) assert.equal(await page.locator('#' + id).isVisible(), true);
  await screenshot('reader-menu-tablet', { fullPage: false });
  await page.locator('#reader-menu').press('Escape');
  await page.locator('#reader-menu').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#reader-more').click();
  assert.equal(await page.locator('#reader-comment').isVisible(), true);
  assert.equal(await page.locator('#reader-comment use').getAttribute('href'), '#i-comment');
  await fetch('http://127.0.0.1:18766/api/opened?workId=epub-demo', { method: 'POST' });
  // A shelf must not inherit an unrelated library query.
  await fetch('http://127.0.0.1:18766/api/opened?workId=2', { method: 'POST' });
  await page.evaluate(() => localStorage.setItem('archive.view', JSON.stringify({
    sort: 'title', state: 'all', include: ['Absent tag'], exclude: ['The Harbour'],
    author: ['Someone else'], rating: ['Explicit'], bookmarkedBy: 'Someone else',
    language: 'fr', complete: '0', wordsMin: '999999', wordsMax: '1',
    chaptersMin: '99', chaptersMax: '1', updatedAfter: '2099-01-01',
    updatedBefore: '1900-01-01', crossover: '1', otp: '1',
  })));
  await page.reload();
  const readingShelf = page.locator('.shelf').filter({ has: page.locator('h2', { hasText: 'Continue reading' }) });
  await readingShelf.getByRole('button', { name: 'See all', exact: false }).click();
  await page.locator('#library').waitFor({ state: 'visible' });
  await page.locator('#works .work-card').filter({ hasText: 'A little light in the afternoon' }).waitFor();
  assert.equal(await page.locator('#sort').inputValue(), 'recent');
  await page.locator('#works .work-card').filter({ hasText: 'Letters from the coast' }).click();
  await page.locator('#detail [data-filter="author"]').first().click();
  await page.locator('#author').waitFor({ state: 'visible' });
  for (const width of [390, 900]) {
    await page.setViewportSize({ width, height: 940 });
    for (const id of ['author-sync-both', 'author-see-all', 'author-block']) {
      const control = await page.locator('#' + id).evaluate(el => ({
        height: el.getBoundingClientRect().height, border: parseFloat(getComputedStyle(el).borderTopWidth),
      }));
      assert.ok(control.height >= 48 && control.border > 0, 'author actions have visible touch targets');
    }
    assert.ok(await page.locator('#author-block').evaluate(el => !el.closest('.author-sync')));
    await screenshot('author-' + width);
  }
  await page.locator('#tabs [data-tab="home"]').click();
  await screenshot('home-dark');
  await page.locator('.fandom-list button').filter({ hasText: 'The Harbour' }).click();
  await page.locator('#library').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 3);
  assert.equal(await page.locator('#works .work-card').count(), 3, 'fandom browse clears the previous reading-only filter');
  // Main destinations and collection entry points remain available on both sizes.
  for (const width of [390, 900]) {
    await page.setViewportSize({ width, height: 940 });
    await page.locator('#tabs [data-tab="activity"]').click();
    await page.locator('#activity').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#sync-now').count(), 1);
    await page.locator('#open-settings').click();
    assert.equal(await page.locator('#settings #account').isVisible(), true);
    assert.equal(await page.locator('#tabs').isVisible(), true);
    await page.locator('#tabs [data-tab="library"]').click();
    await page.locator('[data-collection="bookmarked"]').click();
    await page.locator('#library-sync').click();
    await page.locator('#activity').waitFor({ state: 'visible' });
    await page.locator('#tabs [data-tab="library"]').click();
    await page.locator('[data-collection="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 3);
    assert.equal(await page.locator('#active').innerText(), '');
    await page.locator('#add').click();
    assert.equal(await page.locator('#add-epubs').isVisible(), true);
    await page.locator('#add-bookmarks').click();
    await page.locator('#activity').waitFor({ state: 'visible' });
    await screenshot('v3-downloads-' + width);
  }
  assert.deepEqual(errors, [], 'no browser exceptions');
  console.log('Settings, persistence, reading preview and library browser checks passed');
} finally {
  await browser.close();
  server.kill();
  await once(server, 'exit');
}
