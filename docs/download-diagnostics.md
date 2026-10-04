# Download diagnostics

Android records a local JSONL journal automatically. Downloads → Download diagnostics
→ Export download diagnostics copies it through Android's document picker. Export
again after a failure and restart; logs are not cleared by exporting. No upload occurs.
The two rotating files occupy at most 4 MiB in app-private storage, independently of
SQLite. Clearing app data or uninstalling removes them. Each record has schema,
wall-clock time, monotonic elapsed time, process ID, random process session, event
and controlled data. Export refreshes version/device/system information even if
startup records have rotated out.

## Reading a report

- `process_start` and `previous_process_exit`: compare exit timestamp and PID with
  the prior session. Exit reasons are Android ApplicationExitInfo integer constants
  (Android 11+). Older Android versions cannot supply historical exit reasons.
- `activity_*`, `runtime_attach/detach`, `task_removed`, `service_*`,
  `foreground_*`, `wake_*`: show window, service and wake-lock transitions.
- `service_sample`: every 60 seconds on a separate native thread while the service
  exists; compares native tick and JavaScript acknowledgement ages. This sampler
  adds no wake lock, does not prevent suspension, and has no UI/queue work.
- `native_tick_gap` and `watchdog_interrupted`: the native clock resumed late or
  explicitly stopped the service after a missing JavaScript heartbeat.
- `renderer_*`, `uncaught_exception`, `trim_memory`: renderer trouble, native crash
  class and Android memory pressure. Exceptions contain class names only.
- `system`: network validation, power-saving/Doze/battery-exemption state, memory
  and outstanding request count. No IP, SSID or account information.
- `request_start/headers/end`: process-local request number, status, duration and
  body bytes for each native proxy attempt. End outcome 0 = EOF/no body,
  1 = closed before EOF, 2 = exception. Unmatched starts/headers identify pending
  requests/bodies; they alone do not prove a network failure. Retries are distinct
  attempts. Discarded retry responses are closed. No URL/headers/body are logged.
- `save_work_start/end`: SQLite save boundary and success, without work IDs.
- `queue_progress`: numeric job counters; state indices are queued=0, listing=1,
  running=2, pausing=3, paused=4, done=5, cancelled=6, error=7, unknown=-1.
  Counters describe the job producing the event, not a single combined total.
- `queue`: aggregate job states, pending waits, overdue duration, remaining cooldown,
  page visibility and time since the latest queue event. Samples once per minute
  from the native JavaScript tick and on visibility changes/export. This is not an
  independent proof that a request or save is advancing.
- `js_error/rejection`: occurrence only, never the error message or stack.

No watchdog, retry pacing, battery policy or queue scheduling changes are part of
this instrumentation. A missing final event is expected for a process killed without
callbacks. Clock gaps plus exit records narrow the cause; they do not always prove
which vendor battery policy terminated an app. Records are best-effort if storage
is full or Android kills the process mid-write; ignore a malformed final JSONL line.

Validation uses synthetic downloads, journal restart/rotation and payload filtering,
stream EOF/close/error cases, and browser export callbacks. Actual screen-off and
vendor task-removal behavior still requires a report from an affected device.
