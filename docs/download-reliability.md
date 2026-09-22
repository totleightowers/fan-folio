# Download reliability

## Background scheduling

All queue gaps, retry backoff and listing waits use the same clock that Android can advance while page timers are throttled. A native tick only releases waits whose deadlines have passed; it does not shorten archive pacing or cooldowns.

A job retains ownership of its runner until the in-flight request returns. Resuming while it is still pausing continues that runner instead of starting a second download of the same work.

The foreground service checks that the page acknowledges its clock. If the Activity is destroyed, a sticky service restarts without its queue, or acknowledgements stop for a minute, the service releases its wake lock and shows an interruption notification linking to Downloads. The queue is already persisted after every event and resumes when the app is reopened. This stage does not move the downloader into an independent native worker or promise survival after Android terminates the app process.

Validation: suspended-timer queue/retry/listing tests, in-flight pause/resume tests, the actual Java service command/watchdog logic with platform effects stubbed, Java compilation, full logic/syntax checks and PR checks. Physical Android screen-off, app-switching and process-recreation checks remain unverified without a connected device. All local fixtures avoid AO3 requests.
