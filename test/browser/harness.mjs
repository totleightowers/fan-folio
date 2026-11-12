/**
 * A library on disk, the dev server over it, and a browser pointed at it.
 *
 * Each journey used to carry its own copy of this. New ones start here, so a
 * journey is the steps a reader takes and little else.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { SCHEMA } from '../../app/core/store/schema.js';

/** A work with one short chapter per entry in `chapters`, findable by search. */
export function addWork(db, { id, title, authors = ['Rowan'], summary = 'A short summary.', chapters = 1, words = 3500,
  fandom = 'The Harbour', relationships = [], rating = 'General Audiences', held = true, text = 'Afternoon light filled the room.' }) {
  db.prepare(`INSERT INTO works (work_id,title,authors,summary,has_text,chapter_count,words,rating,complete,updated,downloaded_at)
    VALUES (?,?,?,?,?,?,?,?,1,'2026-09-01','2026-09-02')`)
    .run(String(id), title, JSON.stringify(authors), summary, held ? 1 : 0, chapters, words, rating);
  if (fandom) db.prepare('INSERT INTO tags (work_id,kind,name) VALUES (?,?,?)').run(String(id), 'fandom', fandom);
  for (const name of relationships) db.prepare('INSERT INTO tags (work_id,kind,name) VALUES (?,?,?)').run(String(id), 'relationship', name);
  if (!held) return;
  for (let n = 1; n <= chapters; n++) {
    db.prepare('INSERT INTO chapters (work_id,number,title,html,text,words) VALUES (?,?,?,?,?,?)')
      .run(String(id), n, `Chapter ${n}`, `<p>${text} Paragraph of chapter ${n}.</p>`.repeat(80), `${text} Paragraph of chapter ${n}.`, Math.round(words / chapters));
  }
}

export async function startApp({ port, seed, viewport = { width: 390, height: 844 }, mobile = true }) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const dir = mkdtempSync(join(tmpdir(), 'folio-journey-'));
  const dbPath = join(dir, 'library.db');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  seed(db);
  db.exec("INSERT INTO chapter_fts(chapter_fts) VALUES('rebuild')");
  db.exec("INSERT INTO work_fts(rowid,work_id,title,authors,summary,tags) SELECT rowid,work_id,title,authors,summary,'' FROM works");
  db.close();

  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [new URL('../../tools/serve.mjs', import.meta.url).pathname], {
    cwd: dir, env: { ...process.env, FANFOLIO_DB: dbPath, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const browser = await chromium.launch();
  const close = async () => {
    await browser.close();
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(base + '/api/home')).ok) break; } catch { /* not up yet */ }
      if (i === 100) throw new Error('UI server did not start');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    // Nothing in a journey may depend on the network beyond the app itself.
    await context.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) errors.push(message.text()); });
    return { page, context, base, dbPath, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}
