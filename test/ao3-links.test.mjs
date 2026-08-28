import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkTarget, isAo3Link, workIdFrom, AO3_HOSTS,
  authorWorks, authorProfile, isOrphan } from '../app/core/ao3/urls.js';

/**
 * Every shape an archive link arrives in.
 *
 * People paste all of these. The alternate hosts were checked and each one
 * redirects to archiveofourown.org, so a link on any of them names the same
 * work — but Android matches the URL that was tapped, not the one it ends up
 * at, so all of them have to be recognised here and claimed in the manifest.
 */
const WORK = '23690653';

const NAMES_A_WORK = [
  `https://archiveofourown.org/works/${WORK}`,
  `https://archiveofourown.org/works/${WORK}/`,
  `http://archiveofourown.org/works/${WORK}`,
  `https://www.archiveofourown.org/works/${WORK}`,
  `https://ao3.org/works/${WORK}`,
  `https://www.ao3.org/works/${WORK}`,
  `https://archiveofourown.com/works/${WORK}`,
  // a chapter deep-link still names its work
  `https://archiveofourown.org/works/${WORK}/chapters/58374929`,
  // the full-work view, and the adult interstitial already accepted
  `https://archiveofourown.org/works/${WORK}?view_full_work=true`,
  `https://archiveofourown.org/works/${WORK}?view_adult=true&view_full_work=true`,
  // inside a collection
  `https://archiveofourown.org/collections/somefest2024/works/${WORK}`,
  // the chapter index
  `https://archiveofourown.org/works/${WORK}/navigate`,
  // the archive's own download links, on their own host
  `https://download.archiveofourown.org/downloads/${WORK}/Some%20Title.epub`,
  `https://download.archiveofourown.org/downloads/${WORK}/Some%20Title.html`,
  // shared with tracking junk, or trailing punctuation from a sentence
  `https://archiveofourown.org/works/${WORK}?utm_source=tumblr`,
  `https://archiveofourown.org/works/${WORK}#workskin`,
  // and the bare id, which people paste too
  WORK,
];

for (const url of NAMES_A_WORK) {
  test(`names a work: ${url}`, () => {
    const target = linkTarget(url);
    assert.equal(target.kind, 'work');
    assert.equal(target.workId, WORK);
    assert.equal(workIdFrom(url), WORK, 'the older helper must agree');
  });
}

test('a chapter on its own is not a work id', () => {
  // fetching /works/58374929 would quietly return a different story
  const target = linkTarget('https://archiveofourown.org/chapters/58374929');
  assert.deepEqual(target, { kind: 'chapter', chapterId: '58374929' });
  assert.equal(workIdFrom('https://archiveofourown.org/chapters/58374929'), null);
});

test('a series names many works, not one', () => {
  assert.deepEqual(linkTarget('https://archiveofourown.org/series/1234567'),
    { kind: 'series', seriesId: '1234567' });
});

test('an external work is a stub with nothing to fetch', () => {
  assert.equal(linkTarget('https://archiveofourown.org/external_works/98765').kind, 'external');
});

test('listings name no particular work', () => {
  for (const url of [
    'https://archiveofourown.org/users/someone/works',
    'https://archiveofourown.org/users/someone/bookmarks',
    'https://archiveofourown.org/tags/Fluff/works',
    'https://archiveofourown.org/collections/somefest2024',
    'https://archiveofourown.org/',
  ]) {
    assert.equal(linkTarget(url).kind, 'unknown', `${url} should not resolve to a work`);
  }
});

test('every host the archive answers on is recognised', () => {
  for (const host of AO3_HOSTS) {
    assert.ok(isAo3Link(`https://${host}/works/${WORK}`), `${host} not recognised`);
  }
  assert.equal(isAo3Link('https://example.com/works/123'), false);
  assert.equal(isAo3Link('https://notarchiveofourown.org/works/123'), false);
});

test('a link that is not the archive is refused rather than guessed at', () => {
  assert.equal(linkTarget('https://fanfiction.net/s/123').kind, 'unknown');
  assert.equal(linkTarget('').kind, 'unknown');
  assert.equal(linkTarget(null).kind, 'unknown');
});

/**
 * The manifest decides which links Android offers the app for; the code
 * decides what it can do with one. A host in either and not the other is a
 * link that is either never offered, or offered and then refused.
 */
test('the manifest claims every host the code recognises', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  const claimed = new Set([...manifest.matchAll(/android:host="([^"]+)"/g)].map((m) => m[1]));

  for (const host of AO3_HOSTS) {
    assert.ok(claimed.has(host), `${host} is recognised in code but never claimed in the manifest`);
  }
  for (const host of claimed) {
    assert.ok(AO3_HOSTS.has(host), `${host} is claimed in the manifest but unknown to the code`);
  }
});

test('the manifest claims only paths that can name a work', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = readFileSync(new URL('../android/AndroidManifest.xml', import.meta.url), 'utf8');
  const prefixes = [...manifest.matchAll(/android:pathPrefix="([^"]+)"/g)].map((m) => m[1]);

  // an app that opens and then says it cannot help is worse than one that
  // never offered: these are listings, not works
  for (const claimed of prefixes) {
    assert.ok(!['/users', '/tags', '/collections', '/bookmarks'].includes(claimed),
      `${claimed} is a listing; claiming it takes links the app cannot show`);
  }
  assert.deepEqual(prefixes.sort(), ['/chapters', '/downloads', '/series', '/works']);
});

/*
 * These are the shapes a real library actually holds. Roughly a quarter of
 * the bylines in mine carry a pseud, and not one of them had ever been put
 * through the URL builder before the app started reporting 404s for them.
 * The expected strings below are AO3's own hrefs, read off its work pages.
 */
test('a byline names a pseud, and that is where its works are', () => {
  assert.equal(authorWorks('Anna (pineconepickers)'),
    'https://archiveofourown.org/users/pineconepickers/pseuds/Anna/works?page=1',
    'the whole byline as a username is the 404 this fixes');
  assert.equal(authorWorks('beebalm'),
    'https://archiveofourown.org/users/beebalm/pseuds/beebalm/works?page=1',
    'a bare name is a pseud of the same name');
  assert.equal(authorProfile('Mother of Pearl (notnacre)'),
    'https://archiveofourown.org/users/notnacre/pseuds/Mother%20of%20Pearl',
    'a pseud with a space in it still has to survive being put in a path');
});

test('a tap on an orphaned work does not download the orphanage', () => {
  assert.ok(isOrphan('x______o (orphan_account)'), 'the account is what marks it');
  assert.ok(isOrphan('orphan_account'));
  assert.ok(!isOrphan('beebalm'));
  /* Resolving a byline to its account instead of its pseud would send this
     one to /users/orphan_account, which holds over a million works. */
  assert.match(authorWorks('x______o (orphan_account)'),
    /\/users\/orphan_account\/pseuds\/x______o\/works/,
    'never the bare account');
});
