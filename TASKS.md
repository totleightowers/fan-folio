# What is left

Kept here rather than in my head, so it survives a session and can be argued
with. Newest understanding at the top of each list; struck-through items stay
until the release that fixed them has been tested.

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
