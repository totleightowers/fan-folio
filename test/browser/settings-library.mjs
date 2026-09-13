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
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:18766');
  await page.locator('#home').waitFor({ state: 'visible' });
  await page.locator('#open-settings').click();
  await page.locator('#reading-summary').filter({ hasText: 'Georgia' }).waitFor();
  await page.locator('#haptics').uncheck();
  await page.screenshot({ path: 'ui-screenshots/settings-phone.png', fullPage: true });
  await page.locator('#open-typo').click();
  await page.locator('[data-theme-choice="sepia"]').click();
  await page.locator('[data-face-choice="Literata"]').click();
  await page.locator('#size').focus();
  for (let i = 0; i < 5; i++) await page.locator('#size').press('ArrowRight');
  assert.equal(await page.locator('#size-value').textContent(), '24px');
  assert.equal(await page.locator('.sample').evaluate(el => getComputedStyle(el).fontSize), '24px');
  await page.screenshot({ path: 'ui-screenshots/reading-phone.png' });
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
  for (const [width, height, name] of [[390,844,'phone'], [320,720,'narrow'], [900,900,'tablet']]) {
    await page.setViewportSize({ width, height });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
    await page.screenshot({ path: `ui-screenshots/library-${name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#open-settings').click();
  await page.locator('#open-typo').click();
  await page.locator('[data-theme-choice="light"]').click();
  await page.locator('#typography [data-close]').first().click();
  await page.locator('#back').click();
  await page.screenshot({ path: 'ui-screenshots/library-light.png', fullPage: true });
  assert.deepEqual(errors, [], 'no browser exceptions');
  console.log('Settings, persistence, reading preview and library browser checks passed');
} finally {
  await browser.close();
  server.kill();
  await once(server, 'exit');
}
