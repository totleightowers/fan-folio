# What is left

Kept here rather than in my head, so it survives a session and can be argued
with.

Julia moves between subjects on purpose and expects the list to hold. Nothing
below is dropped because the conversation went somewhere else; it waits until
what is above it is done, and then it is picked up again without being asked
twice.

## Stop 2.x. Port these into 1.x, and that is v2.

Said on 13 September. The Flutter app is put down; the shell-and-page app
under `app/` takes the parts of it that were worth having and becomes v2.

1. **Author view.** A person as a screen rather than the library wearing a
   bar: their name, what they wrote, what they liked, and a sync in plain
   sight on both. The author bar comes *out* of the library view when this
   lands — nothing else about the library changes.
2. **You tab.** What is yours — signed in as, bookmarked, for later,
   finished, blocked.
3. **Settings, set out the way 2.x sets it out.** Sections with headings,
   the library's own actions first.
4. **Activity moves into Settings**, and out of the tab bar, which is what
   frees the third tab for You.
5. **An app icon.**
6. **The work front page, laid out the way 2.x lays it out.**
7. **Everything on a work page clickable**: the byline opens the person,
   everything else opens the library already narrowed to it.

Done in that order, a release each, as ever.

## Stopped: the 2.x list


1. ~~**Check backup and restore.**~~ alpha.28 — a real round trip, and it
   holds. Not "believe it works" — a round trip that
   is actually exercised, because it is the one thing in here that, if it is
   wrong, loses everything else.
2. ~~**Fix download.**~~ alpha.29 — the wire now matches 1.x. Unproven
   against a live 503; needs a phone. The archive answers 503. Most likely us: 2.x sends a
   made-up Chrome user-agent from a Dart HTTP client and drops Cloudflare's
   own cookies, where 1.x sent the device's real WebView agent and kept every
   cookie it had.
3. ~~**Fix the author page.**~~ alpha.29 — two shelves, both populated. One Works tab and one Bookmarks tab, both
   populated from what the library knows, each with a prominent sync that
   walks the archive and merges. The two go-and-look tabs are redundant.
   Populating them means storing what a listing describes rather than only
   what has been downloaded — twenty works for one request.
4. **Fix reader navigation and layout.** Still not right. Said in full:
   - Scrolling up and down still does not work. Possibly the horizontal swipe
     is too eager and takes a drag the chapter should have had.
   - A swipe on the work's front page should open the reader — where you left
     off, or at the beginning if you have not.
   - Do not say "Chapter Text". That is the archive's own landmark heading for
     screen readers and has no business being shown.
   - From inside one chapter, reach: the work's front page, another chapter
     anywhere in the work, and kudos, bookmark and comment.

## Said since, and now in hand

- **Sync means download.** A person's sync walks their pages *and* fetches
  what is missing or stale, rather than only listing it. Works, bookmarks, or
  both in one go.
- **Do not pull the same work twice.** The planner compares the day a copy was
  taken against the date the archive last says the work changed, so most of a
  listing costs nothing. It was ported and then never wired in.
- **Keep 1.x's versioning.** A refetch archives the chapters it replaces
  before writing over them, so an author who rewrites a scene does not take
  the old one with them. Already there; now covered by a test.
- **A backup carries everything**, not only the rows: pictures with their
  bytes, archived chapter and skin versions, tombstones, the blocklist, whose
  bookmarks a work is in. Now asserted rather than assumed — alpha.28 checked
  the text and not the megabytes, which was half a check.

Do not stop after one of these. Ship it, link the release, and move to the
next. When the list is empty, go back to the standing goal.

Standing, underneath all of it: parity with 1.x is not met, and my saying the
list was closed was premature. A release per feature, PR and release linked.

## Asked on 13 September

- ~~**Back-port EPUBs into the library's own format.**~~ In hand: chosen from
  Settings, read in as a job on Activity. A shelf of EPUBs read
  badly; they should become works and chapters like everything else. Where the
  archive has the same work, the archive's copy is the one to read and the
  EPUB is kept as a version of it. Where it does not — a work since deleted,
  a gift never posted — the EPUB is the work.

  Most of this exists already and none of it is in the app: `app/core/epub.js`
  and `app/core/zip.js` read one, and `tools/ingest-epubs.mjs` puts a folder of
  them into a library from a laptop. What is missing is doing it from the
  phone, and deciding between a copy and the archive's.

## Asked on 13 September, later the same day

- ~~**The work page and the reader looked like two different apps.**~~ v2.8.0
  — one column for the whole reader, the rail kept up while reading on a
  screen wide enough to have one, the header opening in the work page's own
  type, and the archive's "CHAPTER 1" heading gone from the top of the prose.

## Now

- **Person screen: Works and Bookmarks, both populated.** The two
  "go and look" tabs are redundant. One Works tab and one Bookmarks tab, each
  showing what the library already knows, each with a prominent Sync that
  walks the archive and merges. Populating them means storing what a listing
  describes rather than only what has been downloaded — twenty works for one
  request, which is how a catalogue becomes browsable.
- **Another pass at the reader.** Reported as still not right after the
  swipe and scroll fixes. Candidates: tap to put the chrome away, a lighter
  foot, the two-line title bar.
- **The skinned webview renders nothing.** Worked around with a fallback to
  plain text; the cause is still unknown. It now reports a load that comes
  back with no height, so the next skinned work should name what it hit.
- **503 from the archive.** Likely us: 2.x sends a hardcoded Chrome
  user-agent from a Dart HTTP client and drops Cloudflare's own cookies,
  where 1.x sent the device's real WebView agent and kept every cookie. See
  below.

## Next

- **Match 1.x on the wire.** Use the device's WebView user-agent rather than a
  made-up one; keep the Cloudflare cookies, which in 2.x were minted by this
  device's own webview; re-read cookies from the webview rather than keeping a
  snapshot taken at sign-in.
- **Reading a work that is not held.** Queues from the work page now; the
  page should follow it rather than needing to be left and come back.
- **Home.** Start Here and Browse are in; the shelves themselves have not
  been looked at since they were ported.

## Known gaps, not yet argued about

- Search has no filters of its own.
- Nothing shows a series.
- No way to see what a sync changed after the fact.

## Done and awaiting a verdict on a phone

- Pictures held rather than fetched on every read; a missing one is offered,
  and what is fetched is kept. A skin's own assets are collected too, which
  1.x never did.
- No release build had INTERNET permission until alpha.25.
- Scrolling, the chapter sheet, work front pages, swipeable chapters,
  sign-in through the archive's own page, the You tab.
