# Download reliability

## Background scheduling

All queue gaps, retry backoff and listing waits use the same clock that Android can advance while page timers are throttled. A native tick only releases waits whose deadlines have passed; it does not shorten archive pacing or cooldowns.

A job retains ownership of its runner until the in-flight request returns. Resuming while it is still pausing continues that runner instead of starting a second download of the same work.

The foreground service checks that the page acknowledges its clock. If the Activity is destroyed, a sticky service restarts without its queue, or acknowledgements stop for a minute, the service releases its wake lock and shows an interruption notification linking to Downloads. The queue is already persisted after every event and resumes when the app is reopened. This stage does not move the downloader into an independent native worker or promise survival after Android terminates the app process.

Validation: suspended-timer queue/retry/listing tests, in-flight pause/resume tests, the actual Java service command/watchdog logic with platform effects stubbed, Java compilation, full logic/syntax checks and PR checks. Physical Android screen-off, app-switching and process-recreation checks remain unverified without a connected device. All local fixtures avoid AO3 requests.

## Counts and outcomes

Progress is derived from distinct per-work records, including after restarting or verifying a save. Historical jobs that did not retain those records preserve their known totals and keep the incomplete-history notice. Active queues are always persisted; the history limit applies only to settled jobs.

Verification checks successful saves without overriding permanent-failure decisions or exhausted request retries. Closing an already drained listing still verifies its saved works. A failed listing retains its own error across restarts, and failures need attention even when no automatic retries remain. Pause and Stop during verification remain authoritative.

Regression coverage includes restoring 20 of 23 downloads, distinct counts through repair passes, permanent/transient retry limits, listing completion/failure, stopping during verification and history retention. The browser checks the restored 20-of-23 display as well as the existing per-work views.

## Inspecting and retrying results

A job's filters show counts for downloaded, pending and attention-needed works. Individual failures offer Retry this work; stopped entries offer Queue this work. Retry unfinished works queues only recorded missing entries, preserving successful peers and stopped outcomes that were not selected. Retry requests made while another work or save verification is in flight remain attached to the same runner.

Each new attempt records its number and time. Automatic retries show their earliest retry time; the shared archive pacer and cooldown can still delay that request. Errors distinguish unavailable works, sign-in requirements, rate limits, temporary archive failures and connection problems. Successful attempts retain identity metadata for later inspection. Missing native JSON values stay null, and missing identity is displayed as a work ID/author-unavailable label.

Run again uses a persisted operation source, including migrations for old bookmark, series, backlog and EPUB job labels. EPUB reruns ask for files again; they never attempt to fetch an author named Your EPUBs. Failed series-list requests get a saved job error.

Earlier versions is beside the story's reading controls and remains visible with an empty history. Existing archived chapter storage, reading-position behavior and the Return to the story pill are retained.

Validation includes queue retries during an active request and verification, selected stopped works, persisted attempt metadata, real rerun routing and missing metadata labels. The browser journey retries only the selected failed ID and opens both populated and empty version histories. Native Java compiles against API 34. Device background validation remains outstanding; no local check contacted AO3.
