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
db.exec("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')");
db.exec("INSERT INTO work_fts(rowid,work_id,title,authors,summary,tags) SELECT rowid,work_id,title,authors,summary,'' FROM works");
db.prepare(`INSERT INTO chapter_versions (id,work_id,number,title,html,text,words,reason,archived_at)
  VALUES (1,'1',1,'Earlier opening','<p>The older beginning.</p>','The older beginning.',4,'content','2026-08-01')`).run();
// Reproduce an older EPUB import: the text is present but its flag was never set.
db.exec("UPDATE works SET has_text=0, source='epub' WHERE work_id='epub-demo'");
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
  const fillSearch = async (query) => {
    if (!(await page.locator('#q').isVisible()) && await page.locator('#context-search').isVisible()) await page.locator('#context-search').click();
    await page.locator('#q').fill(query);
  };
  const openSettings = async () => {
    await page.locator(await page.locator('#nav-settings').isVisible() ? '#nav-settings' : '#open-settings').click();
  };
  const chooseLibraryOption = async (id, value) => {
    await page.locator('#open-filters').click();
    await page.locator('#' + id).selectOption(value);
    await page.locator('#apply-filters').click();
    await page.locator('#filters').waitFor({ state: 'hidden' });
  };
  const checkCardMetadata = async (card) => {
    assert.equal(await card.locator('.card-rating').innerText(), 'General Audiences');
    assert.equal(await card.locator('.card-relationship').innerText(),
      'Jeon Jungkook/Jung Hoseok | J-Hope/Kim Namjoon | RM/Min Yoongi | Suga/Park Jimin');
    assert.ok(await card.locator('.card-metadata').evaluate(el => {
      const box = el.getBoundingClientRect(), cardBox = el.closest('.card').getBoundingClientRect();
      return box.left >= cardBox.left && box.right <= cardBox.right
        && el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight;
    }), 'metadata wraps inside the card without clipping');
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
    assert.equal(await page.locator('#browse-kind').inputValue(), 'fandom');
    assert.ok(await page.locator('#shelves').evaluate(el => el.getBoundingClientRect().top < 220), 'Home begins with stories, not a decorative header');
    await page.locator('#browse-kind').selectOption('relationship');
    assert.match(await page.locator('.fandom-list').innerText(), /Jeon Jungkook/);
    await page.locator('#browse-kind').selectOption('fandom');
    assert.ok(await page.locator('.fandom-list .name').first().evaluate(el => el.scrollWidth <= el.clientWidth), 'short fandom names remain fully readable');
    const homeStory = page.locator('[data-shelf="added"] .card').filter({ hasText: 'The long way home' });
    await checkCardMetadata(homeStory);
    await screenshot('home-' + width);
  }
  // OTP is discoverable without selecting a pairing, survives reopening,
  // and remains removable even when relationship facets are unavailable.
  await page.locator('[data-tab="library"]').click();
  await page.locator('#library').waitFor({ state: 'visible' });
  await page.locator('#open-filters').click();
  const relationships = page.locator('.filter-section').filter({ has: page.locator('.sec-title', { hasText: /^Relationships$/ }) });
  await relationships.locator('.sec-head').click();
  const otp = relationships.getByRole('button', { name: 'OTP · One relationship only', exact: true });
  await otp.click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('archive.view')).otp === '1');
  await page.locator('#apply-filters').filter({ hasText: 'Apply · 1' }).click();
  await page.locator('#filters').waitFor({ state: 'hidden' });
  await page.locator('#works .work-card').filter({ hasText: 'The long way home' }).waitFor();
  assert.equal(await page.locator('#works .work-card').count(), 1);
  await page.reload();
  await page.locator('[data-tab="library"]').click();
  await page.locator('#active').getByRole('button', { name: /OTP/ }).waitFor();
  await page.locator('#works .work-card').filter({ hasText: 'The long way home' }).waitFor();
  assert.equal(await page.locator('#works .work-card').count(), 1);
  await page.route('**/api/facets?**', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.tags.relationship = [];
    await route.fulfill({ json: data });
  });
  await page.locator('#open-filters').click();
  await relationships.locator('.sec-head').click();
  assert.equal(await otp.getAttribute('aria-pressed'), 'true');
  await otp.click();
  await page.locator('#apply-filters').filter({ hasText: 'Apply · 3' }).click();
  await page.locator('#filters').waitFor({ state: 'hidden' });
  await page.unroute('**/api/facets?**');
  await page.locator('[data-tab="home"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings();
  await page.locator('#reading-summary').filter({ hasText: 'Georgia' }).waitFor();
  await screenshot('settings-directory-phone');
  for (const name of ['appearance', 'account', 'library', 'recovery']) {
    await page.locator(`#settings [data-settings-page="${name}"]`).click();
    await page.locator(`#settings-${name}`).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#search-field').isVisible(), false);
    if (name === 'appearance') {
      await page.locator('#settings-appearance [data-theme-choice="sepia"]').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'sepia');
      await page.locator('#settings-appearance details summary').click();
      await page.locator('[data-reading-pref="bg"]').fill('#f1e9da');
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(241, 233, 218)');
      await page.locator('#settings-appearance [data-theme-choice="light"]').click();
    }
    if (name === 'library') {
      assert.equal(await page.locator('#backup').isVisible(), true);
      assert.equal(await page.locator('#import-replace').isVisible(), true);
      assert.equal(await page.locator('#import-epubs').isVisible(), true);
    }
    if (name === 'recovery') {
      await page.locator('#settings-recovery summary').first().click();
      assert.equal(await page.locator('#blocked-list').isVisible(), true);
    }
    await screenshot(`settings-${name}-phone`, { fullPage: false });
    await page.locator(`#settings-${name} [data-settings-home]`).click();
    await page.locator('#settings').waitFor({ state: 'visible' });
  }
  await page.setViewportSize({ width: 900, height: 940 });
  await screenshot('settings-directory-tablet', { fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#settings [data-settings-page="reading"]').click();
  await page.locator('[data-reading-pref="size"]').focus();
  await page.locator('[data-reading-pref="size"]').press('ArrowRight');
  assert.equal(await page.locator('.reading-default-sample').evaluate(el => getComputedStyle(el).fontSize), '20px');
  assert.equal(await page.locator('#size').inputValue(), '20', 'the reader sheet shares the defaults');
  await page.locator('[data-reading-pref="size"]').press('ArrowLeft');
  await page.locator('#haptics').uncheck();
  await screenshot('settings-phone');
  await page.locator('#open-typo').click();
  await page.locator('#typography [data-theme-choice="sepia"]').click();
  await page.locator('#typography [data-face-choice="Literata"]').click();
  await page.locator('#size').focus();
  for (let i = 0; i < 5; i++) await page.locator('#size').press('ArrowRight');
  assert.equal(await page.locator('#size-value').textContent(), '24px');
  assert.equal(await page.locator('.sample').evaluate(el => getComputedStyle(el).fontSize), '24px');
  await screenshot('reading-phone', { reading: true, fullPage: false });
  await page.locator('#reset-reading').click();
  assert.equal(await page.locator('#size').inputValue(), '19');
  assert.equal(await page.locator('#haptics').isChecked(), false, 'reading reset preserves haptics');
  await page.locator('#typography [data-theme-choice="dark"]').click();
  await page.locator('#typography [data-close]').first().click();
  await page.reload();
  await page.locator('#home').waitFor({ state: 'visible' });
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.locator('[data-tab="library"]').click();
  await page.locator('.work-title-link').first().waitFor();
  assert.ok(await page.locator('#works .not-held').count());
  assert.equal(await page.locator('#works .work-card').filter({ hasText: 'Letters from the coast' }).locator('[data-act="ao3"]').count(), 0);
  const imported = page.locator('#works .work-card').filter({ hasText: 'Letters from the coast' });
  assert.equal(await imported.locator('.not-held').count(), 0, 'an imported saved copy is available');
  await imported.locator('.sum').tap();
  await page.locator('#detail .actions .primary').filter({ hasText: 'Read' }).click();
  await page.locator('#reader').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#workskin').textContent.includes('Afternoon light'));
  assert.equal(browser.contexts()[0].pages().length, 1, 'reading a saved EPUB opens no browser tab');
  await page.locator('#back').click();
  await page.locator('#back').click();
  await page.locator('#works .work-title-link').first().waitFor();
  for (const [width, height, name] of [[390,844,'phone'], [320,720,'narrow'], [582,1280,'large-phone'], [900,900,'tablet']]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity)
        .map(a => a.finished.catch(() => {})));
    });
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
  await openSettings();
  await page.locator('#settings [data-settings-page="reading"]').click();
  await page.locator('#open-typo').click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#typography [data-theme-choice="black"]').click();
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)', 'Black stays black when the system is dark');
  await page.locator('#typography [data-theme-choice="light"]').click();
  assert.equal(await page.locator('html').getAttribute('data-dark'), null, 'Light overrides the system dark theme');
  await page.locator('#typography [data-theme-choice="system"]').click();
  assert.equal(await page.locator('html').getAttribute('data-dark'), '');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-dark'));
  await page.locator('#typography [data-theme-choice="light"]').click();
  await page.locator('#typography [data-close]').first().click();
  await page.locator('#back').click();
  await page.locator('#back').click();
  await screenshot('library-light');
  await page.locator('#works .work-card').filter({ hasText: 'The long way home' }).locator('[data-act="open"]').click();
  await page.locator('#reader-head').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#search-field').isVisible(), false, 'the reading header starts quiet');
  await page.locator('#reader-search').click();
  assert.equal(await page.locator('#search-field').isVisible(), true);
  assert.equal(await page.locator('#search-scope').inputValue(), 'work');
  await page.locator('#reader-search').click();
  assert.equal(await page.locator('#reader-search').getAttribute('aria-expanded'), 'false');
  await screenshot('reader-phone', { fullPage: false });
  await page.evaluate(() => window.scrollTo(0, 800));
  // Wait for the downward scroll to be handled before reversing direction.
  // Otherwise the browser can coalesce both scrolls and keep the bar hidden.
  await page.waitForFunction(() => document.querySelector('#chapnav').classList.contains('away'));
  await page.evaluate(() => window.scrollBy(0, -60));
  await page.waitForFunction(() => !document.querySelector('#chapnav').classList.contains('away'));
  await page.locator('#reader-type').click();
  assert.ok(await page.locator('#typography').evaluate(el => el.classList.contains('from-reader')));
  await page.locator('#typography [data-face-choice="Literata"]').click();
  assert.ok((await page.locator('#workskin').evaluate(el => getComputedStyle(el).fontFamily)).includes('Literata'));
  assert.equal(await page.locator('#workskin').evaluate(el => getComputedStyle(el).fontSize), '19px', 'reading text uses the chosen size rather than archive defaults');
  await screenshot('reader-controls', { reading: true, fullPage: false });
  await page.locator('#typography [data-close]').first().click();
  await page.locator('#typography').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement.id === 'reader-type');
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
    assert.ok(await page.evaluate(() => {
      const prose = document.querySelector('#workskin').getBoundingClientRect();
      const heading = document.querySelector('#reader-head').getBoundingClientRect();
      return Math.abs(prose.x - heading.x) < 2 && Math.abs(prose.width - heading.width) < 2;
    }), 'prose and heading share the chosen reading column');
    await screenshot('reader-tablet-' + name, { fullPage: false });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !document.querySelector('#chapnav').classList.contains('away'));
  await page.locator('#reader-type').click();
  await page.locator('#typography [data-theme-choice="dark"]').click();
  await page.locator('#typography [data-close]').first().click();
  await page.locator('#typography').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 900, height: 940 });
  await screenshot('reader-tablet-dark', { fullPage: false });
  assert.equal(await page.locator('#tabs').isVisible(), false, 'tablet reading uses the whole screen');
  assert.equal(await page.locator('#now-reading').isVisible(), false, 'no resume overlay over a chapter');
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
  await page.locator('#works .work-card').filter({ hasText: 'Letters from the coast' }).locator('.work-title-link').click();
  await page.locator('#detail [data-filter="author"]').first().click();
  await page.locator('#author').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#author-block').isVisible(), false, 'author removal stays behind explicit management');
  await page.locator('#author-known').filter({ hasText: '3 works known · 2 downloaded' }).waitFor();
  // Card descriptions are part of the work target, including on the author page.
  const authorCard = page.locator('#author-works .work-card').filter({ hasText: 'Letters from the coast' });
  for (const width of [390, 900, 1225]) {
    await page.setViewportSize({ width, height: 940 });
    for (const target of ['.sum', '.statline', 'padding']) {
      await authorCard.scrollIntoViewIfNeeded();
      if (target === 'padding') await authorCard.tap({ position: { x: 8, y: 8 } });
      else await authorCard.locator(target).tap();
      await page.locator('#detail').waitFor({ state: 'visible', timeout: 5000 });
      assert.match(await page.locator('#detail .work-title').innerText(), /Letters from the coast/);
      assert.equal(await page.locator('#reader').isVisible(), false, 'card body previews the work');
      await page.locator('#back').click();
      await page.locator('#author').waitFor({ state: 'visible' });
    }
    await authorCard.locator('.work-title-link').focus();
    await page.keyboard.press('Enter');
    await page.locator('#detail').waitFor({ state: 'visible' });
    await page.locator('#back').click();
    await page.locator('#author').waitFor({ state: 'visible' });
    await authorCard.locator('[data-act="open"]').tap();
    await page.locator('#reader').waitFor({ state: 'visible' });
    await page.locator('#back').click();
    await page.locator('#author').waitFor({ state: 'visible' });
  }
  // Expanding/collapsing stays local; selecting description text does not navigate.
  await authorCard.evaluate(card => { card.dataset.density = 'compact'; });
  const disclosure = authorCard.locator('.work-description > summary');
  const initiallyOpen = await authorCard.locator('details').evaluate(el => el.open);
  await disclosure.tap();
  assert.equal(await authorCard.locator('details').evaluate(el => el.open), !initiallyOpen);
  assert.equal(await page.locator('#author').isVisible(), true);
  if (initiallyOpen) await disclosure.tap();
  await authorCard.locator('.sum').evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    el.click();
  });
  assert.equal(await page.locator('#author').isVisible(), true, 'selected description text stays available to copy');
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await authorCard.evaluate(card => { card.dataset.density = 'expanded'; });
  await page.locator('#author-management summary').click();
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
    await openSettings();
    await page.locator('#settings [data-settings-page="account"]').click();
    assert.equal(await page.locator('#settings-account #account').isVisible(), true);
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#tabs [data-tab="home"]').click();
  await fillSearch('long');
  await checkCardMetadata(page.locator('#results .card').filter({ hasText: 'The long way home' }));
  await fillSearch('Afternoon');
  await page.locator('#results .hit').first().waitFor();
  assert.equal(await page.locator('#search-scope').inputValue(), 'everything');
  assert.equal(await page.locator('#search-scope option[value="work"]').evaluate(el=>el.disabled), true);
  await page.locator('#search-scope').selectOption('meta');
  await page.locator('#results .work-card').first().waitFor();
  await page.locator('#tabs [data-tab="library"]').click();
  assert.equal(await page.locator('#q').inputValue(), '', 'a tab does not wear an old search query');
  await page.locator('#back').click();
  await page.locator('#results .work-card').first().waitFor();
  assert.equal(await page.locator('#q').inputValue(), 'Afternoon');
  assert.equal(await page.locator('#tabs button.on').getAttribute('data-tab'), 'home', 'Back restores the originating section');
  assert.equal(await page.locator('#search-scope').inputValue(), 'meta');
  await page.locator('#results .work-card').filter({ hasText: 'Letters from the coast' }).locator('.sum').tap();
  await page.locator('#detail .work-title').waitFor();
  assert.equal(await page.locator('#search-scope').inputValue(), 'work');
  assert.equal(await page.locator('#q').inputValue(), '');
  await fillSearch('Afternoon');
  await page.locator('#results .hit').first().waitFor();
  assert.equal(await page.locator('#results .hit').count(), 1);
  assert.match(await page.locator('#results .search-context').innerText(), /Letters from the coast/);
  await page.locator('#back').click();
  await page.locator('#detail').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#q').inputValue(), '');
  await page.locator('#back').click();
  await page.locator('#results .work-card').first().waitFor();
  assert.equal(await page.locator('#search-scope').inputValue(), 'meta');
  await page.locator('#search-scope').selectOption('everything');
  await page.locator('#results .hit').first().waitFor();
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  await page.route('**/api/search?**', async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== 'slow') return route.continue();
    await slow;
    return route.fulfill({ json: { works: [], tags: [], hits: [{ work_id: '1', number: 1, title: 'Stale response', snippet: 'Old result' }] } });
  });
  const requested = page.waitForRequest(r => r.url().includes('/api/search?') && new URL(r.url()).searchParams.get('q') === 'slow');
  await fillSearch('slow');
  await requested;
  await fillSearch('Afternoon');
  await page.locator('#results .hit').first().waitFor();
  const replied = page.waitForResponse(r => r.url().includes('/api/search?') && new URL(r.url()).searchParams.get('q') === 'slow');
  releaseSlow();
  await replied;
  await page.waitForTimeout(100);
  assert.doesNotMatch(await page.locator('#results').innerText(), /Stale response/);
  await screenshot('v3-search-phone', { fullPage: false });
  await fillSearch('harbour');
  await page.locator('#tabs [data-tab="library"]').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#library').isVisible(), true, 'leaving cancels a pending search');
  assert.equal(await page.locator('#q').inputValue(), '');
  // Starting a finished work again resets this reading and preserves earlier completion.
  await fetch('http://127.0.0.1:18766/api/finished?workId=1', { method: 'POST' });
  await page.locator('#works .work-title-link').filter({ hasText: 'The long way home' }).click();
  await page.locator('#detail .actions .primary').filter({ hasText: 'Read again' }).waitFor();
  assert.ok(await page.locator('#detail').evaluate(el =>
    el.querySelector('.actions').getBoundingClientRect().top < el.querySelector('.work-summary').getBoundingClientRect().top),
    'reading is reachable before the full description');
  await page.locator('#detail .actions .primary').click();
  await page.locator('#workskin .userstuff').waitFor();
  const restarted = await (await fetch('http://127.0.0.1:18766/api/works/1')).json();
  assert.equal(restarted.chapters_read, 0);
  assert.equal(restarted.completed_before, 1);
  assert.equal(restarted.at_chapter, 1);
  await page.locator('#reader-more').click();
  await page.locator('#reader-menu [data-go="home"]').click();
  const resume = page.locator('.resume-card').filter({ hasText: 'The long way home' });
  await resume.filter({ hasText: 'Reading again' }).waitFor();
  assert.match(await resume.innerText(), /Reading again/);
  assert.equal(await page.locator('.resume-card').first().evaluate(el => {
    const first = el.getBoundingClientRect(), next = el.nextElementSibling.getBoundingClientRect();
    return Math.abs(first.top - next.top) < 2 && first.right <= next.left;
  }), true, 'phone reading choices share a compact horizontal shelf');
  await screenshot('v3-resume-phone', { fullPage: false });
  assert.equal(await page.locator('#now-reading').isVisible(), false, 'Home already offers the reading shelf');
  // The whole reading card previews the work; Resume remains a distinct action.
  const returnToReadingShelf = async () => {
    const previousCard = await resume.elementHandle();
    await page.locator('#back').click();
    // Home replaces its shelf after refreshing; interact with the new cards.
    await page.waitForFunction(card => !card.isConnected, previousCard);
    await previousCard.dispose();
    await resume.waitFor({ state: 'visible' });
  };
  for (const width of [390, 900, 1225]) {
    await page.setViewportSize({ width, height: 940 });
    await checkCardMetadata(resume);
    for (const target of ['padding', '.by', '.card-relationship', '.card-rating', '.resume-position', '.bar']) {
      await resume.scrollIntoViewIfNeeded();
      const position = target === 'padding' ? { x: 8, y: 8 } : await resume.evaluate((el, selector) => {
        const card = el.getBoundingClientRect(), part = el.querySelector(selector).getBoundingClientRect();
        return { x: part.left - card.left + part.width / 2, y: part.top - card.top + part.height / 2 };
      }, target);
      await resume.tap({ position });
      await page.locator('#detail').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('#detail .work-title').filter({ hasText: 'The long way home' }).waitFor({ state: 'visible' });
      assert.equal(await page.locator('#reader').isVisible(), false, 'the card previews, not resumes');
      await returnToReadingShelf();
    }
    // Keep both native buttons keyboard accessible, with a single navigation each.
    await resume.locator('.work-title-link').focus();
    await page.keyboard.press('Enter');
    await page.locator('#detail').waitFor({ state: 'visible' });
    await returnToReadingShelf();
    await resume.locator('.resume-action').tap();
    await page.locator('#reader').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#detail').isVisible(), false, 'Resume goes directly to reading');
    await returnToReadingShelf();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await resume.locator('.resume-action').focus();
  await page.keyboard.press('Space');
  await page.locator('#reader').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#detail').isVisible(), false, 'Resume goes directly to reading');
  await page.locator('#back').click();
  await page.locator('#home').waitFor({ state: 'visible' });
  await page.locator('#tabs [data-tab="activity"]').click();
  assert.equal(await page.locator('#now-reading').isVisible(), true);
  assert.match(await page.locator('#now-reading-title').innerText(), /The long way home/);
  await page.locator('#now-reading').click();
  await page.locator('#reader').waitFor({ state: 'visible' });
  await page.locator('#back').click();
  await page.locator('#activity').waitFor({ state: 'visible' });
  // Density never discards a description; independent filters survive the return journey.
  await page.locator('#tabs [data-tab="library"]').click();
  await page.locator('[data-collection="reading"]').click();
  await chooseLibraryOption('availability', 'held');
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 2);
  assert.equal(await page.locator('#active').innerText().then(s => /Reading/.test(s) && /Downloaded/.test(s)), true);
  await chooseLibraryOption('library-density', 'compact');
  const story = page.locator('#works .work-card').filter({ hasText: 'The long way home' });
  assert.equal(await story.locator('.sum').isVisible(), false);
  await story.locator('.work-description summary').click();
  assert.equal(await story.locator('.sum').isVisible(), true);
  assert.match(await story.locator('.sum').innerText(), /The final sentence stays visible/);
  await story.locator('.author-link').click();
  await page.locator('#author').waitFor({ state: 'visible' });
  await page.locator('#back').click();
  await page.locator('#library').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 2);
  assert.equal(await page.locator('#availability').inputValue(), 'held');
  assert.equal(await page.locator('#library-density').inputValue(), 'compact');
  for (const width of [390, 900]) {
    await page.setViewportSize({ width, height: 940 });
    await screenshot('v3-library-compact-' + width, { fullPage: false });
  }
  // Choose → preview → read → return keeps the same filtered collection.
  await page.locator('#works .work-title-link').filter({ hasText: 'The long way home' }).click();
  await page.locator('#preview-story .work-title').waitFor();
  assert.equal(await page.locator('#preview-library').isVisible(), true);
  assert.equal(await page.locator('#preview-list button').count(), 2);
  assert.match(await page.locator('#preview-story .work-summary').innerText(), /The final sentence stays visible/);
  await page.locator('#preview-list button').filter({ hasText: 'Letters from the coast' }).click();
  await page.locator('#preview-story .work-title').filter({ hasText: 'Letters from the coast' }).waitFor();
  assert.match(await page.locator('#preview-story .saved-copy').innerText(), /Imported EPUB/);
  await screenshot('v3-library-preview-tablet', { fullPage: false });
  await page.locator('#preview-story .actions .primary').click();
  await page.locator('#reader-head').waitFor({ state: 'visible' });
  await page.locator('#to-work').click();
  await page.locator('#preview-story .work-title').filter({ hasText: 'Letters from the coast' }).waitFor();
  assert.equal(await page.locator('#preview-library').isVisible(), true, 'the reader returns to the same preview and collection');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('#preview-library').isVisible(), false);
  assert.equal(await page.locator('#preview-return').isVisible(), true);
  await screenshot('v3-library-preview-phone', { fullPage: false });
  await page.locator('#preview-return').click();
  await page.waitForFunction(() => !document.querySelector('#library').hidden && document.querySelectorAll('#works .work-card').length === 2);
  assert.equal(await page.locator('#availability').inputValue(), 'held');
  assert.equal(await page.locator('#library-density').inputValue(), 'compact');
  // A slow old filter response cannot replace the latest collection.
  let oldResponse;
  const oldArrived = new Promise(resolve => { oldResponse = resolve; });
  await page.route('**/api/works?*', async route => {
    if (new URL(route.request().url()).searchParams.get('availability') === 'known') {
      const response = await route.fetch(); oldResponse();
      await new Promise(resolve => setTimeout(resolve, 450));
      await route.fulfill({ response });
    } else await route.continue();
  });
  await chooseLibraryOption('availability', 'known');
  await oldArrived;
  await chooseLibraryOption('availability', 'held');
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 2);
  await page.waitForTimeout(550);
  assert.equal(await page.locator('#works .work-card').count(), 2);
  await page.unroute('**/api/works?*');
  await page.reload();
  await page.locator('#tabs [data-tab="library"]').click();
  assert.equal(await page.locator('#library-density').inputValue(), 'compact', 'density choice persists');
  assert.equal(await page.locator('#availability').inputValue(), 'held', 'availability persists');
  await chooseLibraryOption('library-density', 'expanded');
  // Restored job records expose the outcome without issuing any network requests.
  await page.evaluate(() => localStorage.setItem('fanfolio.jobs', JSON.stringify([
    { author: 'Rowan', part: 'works', state: 'done', total: 3, added: 2, failed: 1,
      unfinished: ['9999'], workIds: [], lastError: 'Archive request failed (525)', at: Date.now(), historyComplete: true,
      items: [{workId:'1',state:'downloaded'}, {workId:'epub-demo',state:'downloaded'},
        {workId:'9999',state:'failed',error:'Archive request failed (525)'}] },
    { author: 'Waiting collection', part: 'works', state: 'paused', total: 1, workIds: ['2'], historyComplete: true,
      items: [{workId:'2',state:'waiting'}] },
    { author: 'Older collection', part: 'works', state: 'done', total: 30, added: 30, workIds: [] },
    { author: 'Restarted collection', part: 'works', state: 'paused', total: 23, added: 20,
      workIds: ['101','102','103'], historyComplete: true,
      items: [...Array.from({length:20}, (_,i) => ({workId:String(2000+i),state:'downloaded'})),
        ...['101','102','103'].map(workId => ({workId,state:'waiting'}))] },
    { author: 'Large collection', part: 'works', state: 'done', total: 55, added: 55, workIds: [], historyComplete: true,
      items: Array.from({length:55}, (_,i) => ({workId:String(1000+i),state:'downloaded'})) },
  ])));
  await page.reload();
  await page.locator('#tabs [data-tab="activity"]').click();
  await page.locator('#download-state').filter({ hasText: 'Downloads paused' }).waitFor();
  assert.match(await page.locator('.job-error-detail').innerText(), /525/);
  assert.match(await page.locator('.job-open').filter({ hasText: 'Restarted collection' }).innerText(), /20 of 23/);
  assert.equal(await page.locator('#downloads-pause').isVisible(), false);
  assert.equal(await page.locator('#downloads-resume').isVisible(), true);
  assert.equal(await page.locator('.download-help').evaluate(el => el.open), false);
  await page.locator('.job-act[aria-label="Try the 1 that never arrived again"]').waitFor();
  for (const width of [390, 900]) {
    await page.setViewportSize({ width, height: 940 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('v3-download-status-' + width, { fullPage: false });
  }
  await page.locator('.job-open').filter({ hasText: 'Rowan' }).click();
  await page.locator('#job-works [data-work-id="1"] .primary').waitFor();
  assert.equal(await page.locator('#job-works .job-work').count(), 3);
  assert.equal(await page.locator('#job-works [data-work-id="2"]').count(), 0, 'a job only shows its own works');
  assert.match(await page.locator('#job-works [data-work-id="9999"]').innerText(), /525/);
  await page.locator('[data-job-filter="downloaded"]').click();
  await page.locator('#job-works[aria-busy="false"]').waitFor();
  assert.equal(await page.locator('#job-works [data-work-id="9999"]').count(), 0);
  assert.equal(await page.locator('#job-works .job-work').count(), 2);
  await page.locator('#job-works [data-work-id="epub-demo"] .primary').click();
  await page.waitForFunction(() => !document.querySelector('#reader').hidden && document.querySelector('#workskin').textContent.includes('Afternoon'));
  await page.locator('#back').click();
  await page.locator('#download-job').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-job-filter="downloaded"]').getAttribute('aria-pressed'), 'true');
  for (const width of [320, 900]) {
    await page.setViewportSize({ width, height: 940 });
    await screenshot('job-works-' + width, { fullPage: false });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.locator('#back').click();
  await page.locator('.job-open').filter({ hasText: 'Waiting collection' }).click();
  await page.locator('#job-works [data-work-id="2"]').waitFor();
  assert.match(await page.locator('#job-works [data-work-id="2"]').innerText(), /Paused/);
  assert.equal(await page.locator('#job-works .primary').count(), 0, 'a waiting work is not offered as readable');
  await page.locator('#back').click();
  await page.locator('.job-open').filter({ hasText: 'Older collection' }).click();
  assert.equal(await page.locator('#job-history-note').isVisible(), true);
  await page.locator('#back').click();
  await page.locator('.job-open').filter({ hasText: 'Large collection' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#job-works .job-work').length === 50);
  await page.locator('#job-next').click();
  await page.waitForFunction(() => document.querySelectorAll('#job-works .job-work').length === 5);
  assert.equal(await page.locator('#job-next').isDisabled(), true);
  await page.reload();
  await page.locator('#tabs [data-tab="activity"]').click();
  await page.locator('.job-open').filter({ hasText: 'Rowan' }).click();
  await page.locator('#job-works [data-work-id="epub-demo"] .primary').waitFor();
  await page.locator('#back').click();
  await page.locator('#downloads-library').click();
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 2);
  assert.equal(await page.locator('#availability').inputValue(), 'held');
  await page.locator('#works .author-link').first().click();
  await page.locator('#author-sync-this').click();
  await page.locator('#settings-account').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#account').isVisible(), true, 'signed-out sync leads to the account');
  // Back to an earlier version preserves the copy and never changes current reading progress.
  await page.locator('#tabs [data-tab="library"]').click();
  await page.locator('[data-collection="all"]').click();
  await page.locator('#works .work-title-link').filter({ hasText: 'The long way home' }).click();
  await page.locator('#detail').getByRole('button', { name: 'Earlier versions (1)', exact: true }).click();
  await page.locator('#versions-list .version-row').click();
  await page.locator('#archive-banner').waitFor({ state: 'visible' });
  await page.locator('#versions-dialog').waitFor({ state: 'hidden' });
  const beforeVersion = await (await fetch('http://127.0.0.1:18766/api/works/1')).json();
  await page.locator('#reader-more').click();
  await page.locator('#reader-menu [data-go="settings"]').click();
  await page.locator('#reader-menu').waitFor({ state: 'hidden' });
  await page.locator('#back').click();
  await page.locator('#archive-banner').waitFor({ state: 'visible' });
  await page.locator('#workskin').filter({ hasText: 'The older beginning' }).waitFor();
  assert.match(await page.locator('#workskin').innerText(), /The older beginning/);
  assert.equal(await page.locator('#next').isDisabled(), true);
  const afterVersion = await (await fetch('http://127.0.0.1:18766/api/works/1')).json();
  assert.equal(afterVersion.at_chapter, beforeVersion.at_chapter);
  assert.equal(afterVersion.offset, beforeVersion.offset);
  await page.locator('#ab-current').click();
  await page.locator('#archive-banner').waitFor({ state: 'hidden' });
  await page.locator('#rh-chapter').waitFor({ state: 'visible' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#reader-more').click();
  await page.locator('#reader-menu').press('Escape');
  await page.locator('#reader-menu').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement.id === 'reader-more');
  assert.equal(await page.locator('dialog').evaluateAll(dialogs => dialogs.every(d =>
    d.getAttribute('aria-labelledby') && document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim())), true,
    'every dialog has an accessible name');
  await page.locator('#reader-search').click();
  await fillSearch('Afternoon');
  await page.locator('#results .hit').first().waitFor();
  assert.match(await page.locator('#results .search-context').innerText(), /current copy/);
  await page.locator('#back').click();
  await page.locator('#reader').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#search-field').isVisible(), false);
  // A search peek remains transient when returning at a different viewport height.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#rh-chapter').filter({ hasText: 'Chapter 1' }).waitFor();
  await page.locator('#next').click();
  await page.locator('#rh-chapter').filter({ hasText: 'Chapter 2' }).waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const savedPlace = page.waitForResponse(r => r.url().includes('/api/progress?workId=1&chapter=2&offset=125') && r.status() === 200);
  await page.evaluate(() => window.scrollTo(0, 125));
  await savedPlace;
  await page.locator('#reader-search').click();
  await fillSearch('Afternoon');
  await page.locator('#results .hit').first().click();
  await page.locator('#workskin .userstuff').waitFor();
  await page.evaluate(() => window.scrollTo(0, 550));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollBy(0, -40));
  await page.locator('#reader-more').click();
  await page.locator('#reader-menu [data-go="settings"]').click();
  await page.setViewportSize({ width: 390, height: 480 });
  await page.locator('#back').click();
  await page.locator('#workskin .userstuff').waitFor();
  await page.waitForTimeout(600);
  const afterPeek = await (await fetch('http://127.0.0.1:18766/api/works/1')).json();
  assert.equal(afterPeek.at_chapter, 2, 'returning to a search peek cannot replace the reading chapter');
  assert.equal(afterPeek.offset, 125);
  // The return pill must leave a search peek and resume the saved chapter/offset.
  await page.evaluate(() => window.scrollBy(0, -60));
  await page.waitForFunction(() => !document.querySelector('#chapnav').classList.contains('away'));
  await page.locator('#reader-more').click();
  await page.locator('#reader-menu [data-go="settings"]').click();
  await page.locator('#now-reading').waitFor({ state: 'visible' });
  assert.match(await page.locator('#now-reading-place').innerText(), /Return to the story · Chapter 2/);
  assert.ok(await page.locator('#now-reading').evaluate(el => {
    const pill = el.getBoundingClientRect(), tabs = document.querySelector('#tabs').getBoundingClientRect();
    return pill.bottom <= tabs.top && pill.left >= 0 && pill.right <= innerWidth;
  }), 'the return pill stays above phone navigation');
  await page.locator('#now-reading').click();
  await page.waitForFunction(() => document.querySelector('#workskin').textContent.includes('harbour was quiet'));
  await page.waitForFunction(() => Math.abs(window.scrollY - 125) < 5);
  assert.equal(await page.locator('#now-reading').isVisible(), false, 'the pill stays out of the reading page');

  // A preview opened beyond the first batch returns to that batch and offset.
  const largeLibrary = new DatabaseSync(dbPath);
  const insert = largeLibrary.prepare("INSERT INTO works (work_id,title,authors,summary,has_text,chapter_count,words,complete) VALUES (?,?,?, ?,0,1,100,1)");
  for (let n = 1; n <= 55; n++) insert.run(`epub-collection${n}`, `Collection story ${String(n).padStart(3, '0')}`, '["Rowan"]', 'A story in a large collection.');
  largeLibrary.close();
  await page.setViewportSize({ width: 900, height: 940 });
  await page.locator('#reader-more').click();
  await page.locator('#reader-menu [data-go="library"]').click();
  await page.locator('[data-collection="all"]').click();
  await chooseLibraryOption('availability', 'known');
  await page.locator('#sort').selectOption('title');
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length >= 50);
  await page.locator('#more').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 56);
  const lastChoice = page.locator('#works .work-title-link').filter({ hasText: 'Collection story 055' });
  await lastChoice.scrollIntoViewIfNeeded();
  const collectionY = await page.evaluate(() => window.scrollY);
  await lastChoice.click();
  await page.locator('#preview-story .work-title').filter({ hasText: 'Collection story 055' }).waitFor();
  assert.equal(await page.locator('#preview-list button').count(), 56);
  await page.locator('#preview-return').click();
  await page.waitForFunction(() => !document.querySelector('#library').hidden && document.querySelectorAll('#works .work-card').length === 56);
  await page.waitForFunction(y => Math.abs(window.scrollY - y) < 3, collectionY);
  assert.equal(await page.locator('#availability').inputValue(), 'known');
  // Updating a preview in place must not add a second copy to Back history.
  await chooseLibraryOption('availability', 'held');
  await page.waitForFunction(() => document.querySelectorAll('#works .work-card').length === 2);
  await page.locator('#works .work-title-link').filter({ hasText: 'Letters from the coast' }).click();
  await page.locator('#preview-story button').filter({ hasText: /^Mark finished$/ }).click();
  await page.locator('#preview-story .actions .primary').filter({ hasText: 'Read again' }).waitFor();
  await page.locator('#back').click();
  await page.locator('#library').waitFor({ state: 'visible', timeout: 5000 });
  // A failed work can be retried without re-fetching its successful peers.
  const retried = [];
  await page.route('**/api/add?*', route => {
    const id = new URL(route.request().url()).searchParams.get('url');
    retried.push(id);
    return route.fulfill({ json: { workId: id, title: 'Recovered work', authors: ['Rowan'], chapters: 1 } });
  });
  await page.locator('#tabs [data-tab="activity"]').click();
  await page.locator('.job-open').filter({ hasText: 'Rowan' }).click();
  await page.locator('[data-job-filter="failed"]').click();
  await page.locator('#job-works [data-work-id="9999"] .job-retry').click();
  await page.locator('#job-summary').filter({ hasText: '3 downloaded' }).waitFor();
  assert.deepEqual(retried, ['9999']);
  await page.locator('[data-job-filter="downloaded"]').click();
  await page.locator('#job-works [data-work-id="9999"] .job-attempt').waitFor();
  assert.match(await page.locator('#job-works [data-work-id="9999"]').innerText(), /Attempt 1/);
  await screenshot('download-results-retried', { fullPage: false });
  // Even an empty version history is discoverable beside the Read button.
  await page.locator('#tabs [data-tab="library"]').click();
  await page.locator('#works .work-title-link').filter({ hasText: 'Letters from the coast' }).click();
  await page.locator('#detail').getByRole('button', { name: 'Earlier versions (0)', exact: true }).click();
  await page.locator('#versions-list').filter({ hasText: 'Nothing has changed' }).waitFor();
  await page.locator('[data-close="versions-dialog"]').click();
  assert.deepEqual(errors, [], 'no browser exceptions');
  console.log('Settings, persistence, reading preview and library browser checks passed');
} finally {
  await browser.close();
  server.kill();
  await once(server, 'exit');
}
