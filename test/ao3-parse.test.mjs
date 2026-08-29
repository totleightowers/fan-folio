import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseListing, parseBlurb, splitBlurbs, parseWorkPage, parseWorkSkin, imageUrls,
  parseWorkMeta,
} from '../app/core/ao3/parse.js';
import { workPage, readings, bookmarks, PER_PAGE } from '../app/core/ao3/urls.js';

const listing = readFileSync(new URL('./fixtures/listing.html', import.meta.url), 'utf8');
const workHtml = readFileSync(new URL('./fixtures/work-page.html', import.meta.url), 'utf8');

test('a listing splits into its works', () => {
  assert.equal(splitBlurbs(listing).length, 3);
});

test('a blurb yields the fields a sync decision needs', () => {
  const [first] = parseListing(listing).works;
  assert.equal(first.workId, '60710533');
  assert.equal(first.title, 'Deltagroup');
  assert.deepEqual(first.authors, ['iHateFridays']);
  assert.equal(first.anonymous, false);
  assert.deepEqual(first.fandoms, ['Deltarune (Video Game)']);
  assert.equal(first.rating, 'Teen And Up Audiences');
  assert.equal(first.words, 58834);
  assert.equal(first.chapters, 18);
});

test('updated_at comes from the epoch comment, not the rendered date', () => {
  const [first] = parseListing(listing).works;
  assert.equal(first.updatedAt, 1787732527);
  assert.equal(typeof first.updatedAt, 'number');
});

test('an unfinished work is not marked complete', () => {
  const [first] = parseListing(listing).works;
  assert.equal(first.complete, false);
  assert.equal(first.chaptersPlanned, null, 'Chapters: 18/? has no planned total');
});

test('tag groups stay in their own buckets', () => {
  const [first] = parseListing(listing).works;
  assert.ok(first.warnings.includes('Graphic Depictions Of Violence'));
  assert.ok(first.relationships.some((r) => r.includes('Kris')));
  // a warning must not leak into freeform tags
  assert.ok(!first.freeform.includes('Graphic Depictions Of Violence'));
});

test('history-only fields are absent, not null, on a normal listing', () => {
  const [first] = parseListing(listing).works;
  assert.ok(!('lastVisited' in first), 'would overwrite good data when merging');
});

test('a history blurb yields visit info', () => {
  const li = `<li id="work_123" class="work blurb group">
    <h4 class="viewed heading">Last visited: 12 Mar 2024 (Latest version.) Visited 3 times</h4></li>`;
  const w = parseBlurb(li);
  assert.equal(w.lastVisited, '12 Mar 2024');
  assert.equal(w.visits, 3);
  assert.equal(w.staleSinceVisit, false);
});

test('a work page yields chapters and identity', () => {
  const w = parseWorkPage(workHtml);
  assert.equal(w.title, 'Deltagroup');
  assert.deepEqual(w.authors, ['iHateFridays']);
  assert.ok(w.chapters.length >= 1);
  assert.ok(w.chapters[0].html.length > 200, 'chapter body should carry real text');
});

test('no work skin is reported as null, not as site CSS', () => {
  assert.equal(parseWorkSkin(workHtml), null);
});

test('a work skin is picked up only from inside the skin wrapper', () => {
  const page = `<style>.site{color:red}</style>
    <div id="work-skin" class="wrapper">
      <style type="text/css">#workskin .twtchat { border: 1px solid; }</style>
      <!-- BEGIN section where work skin applies -->
      <div id="workskin"><style>.late{}</style></div>`;
  const css = parseWorkSkin(page);
  assert.ok(css.includes('twtchat'));
  assert.ok(!css.includes('.site'), 'site chrome CSS must not be applied to story text');
  assert.ok(!css.includes('.late'), 'only the wrapper region counts');
});

test('remote images are collected, relative ones ignored', () => {
  const html = '<img src="https://pbs.twimg.com/a.jpg"><img src="/images/skin.png"><img src="https://pbs.twimg.com/a.jpg">';
  assert.deepEqual(imageUrls(html), ['https://pbs.twimg.com/a.jpg'], 'deduped, remote only');
});

test('urls are built, not concatenated ad hoc', () => {
  assert.match(workPage(123), /works\/123\?.*view_full_work=true/);
  assert.match(readings('some user', 3), /users\/some%20user\/readings\?page=3/);
  assert.match(bookmarks('me'), /users\/me\/bookmarks\?page=1/);
  assert.equal(PER_PAGE, 20);
});

const bookmarksHtml = readFileSync(new URL('./fixtures/bookmarks.html', import.meta.url), 'utf8');

test('bookmark blurbs parse — the work id lives in the class, not the id', () => {
  const { works } = parseListing(bookmarksHtml);
  assert.equal(works.length, 3, 'a bookmarks page must not silently yield nothing');
  assert.equal(works[0].workId, '84958336');
  assert.equal(works[0].bookmarkId, '3057267451');
  assert.equal(works[0].title, 'mate at first sight (or one thousandth)');
});

test('the bookmark date is not the work date', () => {
  const [first] = parseListing(bookmarksHtml).works;
  assert.equal(first.bookmarkedAt, '10 Aug 2026');
  assert.equal(first.datetime, '24 Jun 2026', 'header datetime is when the work was revised');
  assert.equal(first.updatedAt, 1782446201);
});

test('a works listing has no bookmark fields', () => {
  const [first] = parseListing(listing).works;
  assert.ok(!('bookmarkId' in first));
  assert.ok(!('bookmarkedAt' in first));
});

test('nested markup is not truncated at the first closing tag', async () => {
  const { innerHtmlOf } = await import('../app/core/ao3/parse.js');
  const html = '<div class="userstuff module">'
    + '<div class="twtchat"><div class="messagebody"><p class="text">hi</p></div></div>'
    + '<p>prose after the chat</p></div><div class="afterword">notes</div>';
  const inner = innerHtmlOf(html, /<div class="userstuff module"[^>]*>/i);
  assert.ok(inner.includes('prose after the chat'), 'content after nested divs must survive');
  assert.ok(!inner.includes('afterword'), 'and it must stop at the right closing tag');
});

test('the last chapter stops at its own closing tag, not the end of the page', () => {
  const page = '<div id="chapters">'
    + '<div class="chapter" id="chapter-1"><div class="userstuff module"><p>One.</p></div></div>'
    + '<div class="chapter" id="chapter-2"><div class="userstuff module"><p>Two.</p></div></div>'
    + '</div><form><input name="authenticity_token" value="XYZ"></form><div id="footer">junk</div>';
  const w = parseWorkPage(`<div id="workskin">${page}`);
  assert.equal(w.chapters.length, 2);
  assert.ok(!w.chapters[1].block.includes('authenticity_token'), 'the kudos form is not chapter two');
  assert.ok(!w.chapters[1].block.includes('footer'), 'nor is the page footer');
  assert.ok(w.chapters[1].html.includes('Two.'));
});

test('a work id is recovered from every shape a link gets pasted in', async () => {
  const { workIdFrom } = await import('../app/core/ao3/urls.js');
  const cases = [
    ['https://archiveofourown.org/works/23690653', '23690653'],
    ['https://archiveofourown.org/works/23690653/chapters/56789', '23690653'],
    ['https://archiveofourown.org/works/23690653?view_full_work=true', '23690653'],
    ['https://archiveofourown.org/works/23690653#workskin', '23690653'],
    ['http://archiveofourown.org/works/23690653/', '23690653'],
    ['https://www.archiveofourown.org/works/23690653', '23690653'],
    ['https://archiveofourown.org/collections/some_fest/works/23690653', '23690653'],
    ['  https://archiveofourown.org/works/23690653  ', '23690653'],
    ['23690653', '23690653'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(workIdFrom(input), expected, `failed for ${input}`);
  }
});

test('something that is not a work gives null rather than a guess', async () => {
  const { workIdFrom } = await import('../app/core/ao3/urls.js');
  for (const bad of [
    '', null, undefined, 'https://archiveofourown.org/users/someone/works',
    'https://archiveofourown.org/tags/Fluff/works', 'not a url', 'https://example.com/works/',
  ]) {
    assert.equal(workIdFrom(bad), null, `should not have found an id in ${bad}`);
  }
});

test('the signed-in name is read from the page the session returns', async () => {
  const { signedInUser } = await import('../app/core/ao3/parse.js');
  const page = `<div id="greeting"><ul class="menu">
      <li><a href="/users/Githaw">My Dashboard</a></li></ul></div>`;
  assert.equal(signedInUser(page), 'Githaw');
});

test('a signed-out page names nobody', async () => {
  const { signedInUser } = await import('../app/core/ao3/parse.js');
  assert.equal(signedInUser('<div id="greeting"><a href="/users/login">Log In</a></div>'), null);
  assert.equal(signedInUser(''), null);
});

test("a person's page says how much they have", async () => {
  const { parseUserCounts } = await import('../app/core/ao3/parse.js');
  const page = `<ul class="navigation actions">
      <li><a href="/users/andlovetoo/profile">Profile</a></li>
      <li><a href="/users/andlovetoo/works">Works (89)</a></li>
      <li><a href="/users/andlovetoo/bookmarks">Bookmarks (1,503)</a></li>
    </ul>`;
  assert.deepEqual(parseUserCounts(page), { works: 89, bookmarks: 1503 });
});

test('a count the page does not give is not zero', async () => {
  const { parseUserCounts } = await import('../app/core/ao3/parse.js');
  /* "the page did not say" and "they have none" lead to opposite decisions:
     one means walk to find out, the other means there is nothing to walk. */
  const page = '<ul class="navigation actions"><li><a href="/users/x/works">Works (4)</a></li></ul>';
  assert.deepEqual(parseUserCounts(page), { works: 4, bookmarks: null });
  assert.deepEqual(parseUserCounts(''), { works: null, bookmarks: null });
});

/*
 * The archive prints a Completed date only where there is one — that is,
 * where the work was updated after it was posted. A one-shot posted finished
 * has only a Published date, so reading completeness from that word alone
 * called every single-chapter work a work in progress: 1,569 of mine.
 */
test('a work with all its chapters posted is finished, said or not', () => {
  const page = (stats) => `<dl class="work meta group">
    <dd class="stats"><dl class="stats">${stats}</dl></dd></dl>`;

  const oneShot = parseWorkMeta(page(
    '<dt>Published:</dt><dd class="published">2020-11-25</dd>'
    + '<dt>Words:</dt><dd class="words">40292</dd>'
    + '<dt>Chapters:</dt><dd class="chapters">1/1</dd>'));
  assert.equal(oneShot.complete, true,
    'Chapters: 1/1 is the archive saying the work is done');
  assert.equal(oneShot.chapters, 1);
  assert.equal(oneShot.chaptersPlanned, 1);

  const wip = parseWorkMeta(page(
    '<dt>Published:</dt><dd class="published">2020-11-25</dd>'
    + '<dt>Chapters:</dt><dd class="chapters">3/?</dd>'));
  assert.equal(wip.complete, false, 'an unknown total is still in progress');
  assert.equal(wip.chaptersPlanned, null);

  const partway = parseWorkMeta(page(
    '<dt>Chapters:</dt><dd class="chapters">4/12</dd>'));
  assert.equal(partway.complete, false, 'four of twelve is not finished');

  const said = parseWorkMeta(page(
    '<dt>Completed:</dt><dd class="status">2021-01-02</dd>'
    + '<dt>Chapters:</dt><dd class="chapters">12/12</dd>'));
  assert.equal(said.complete, true, 'and the word still counts when it is there');
});
