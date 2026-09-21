# v3 feature rollout

The UI assessment is accepted for implementation. Each feature receives its own signed commits, PR, checked integration and release before the next feature begins. The v2.10.4 source and APK stay frozen.

| Release | Feature | Status |
|---|---|---|
| 3.0.0 | Home / Library / Downloads navigation; account in Settings; collection shortcuts; unified Add entry | [Released](https://github.com/totleightowers/fan-folio/releases/tag/v3.0.0), [PR #186](https://github.com/totleightowers/fan-folio/pull/186) |
| 3.1.0 | Explicit search scope and reliable query/return state | [Released](https://github.com/totleightowers/fan-folio/releases/tag/v3.1.0), [PR #187](https://github.com/totleightowers/fan-folio/pull/187) |
| 3.2.0 | Direct resume, reading state and work-page priorities | Implemented; release validation |
| 3.3.0 | Coherent Library presentation and filters | Planned |
| 3.4.0 | Download progress and author management journeys | Planned |
| 3.5.0 | Reader controls, settings and final journey/accessibility pass | Planned |

The Android package and signing key are retained. Validate each changed journey in browser fixtures at phone and tablet sizes, run the applicable logic/native checks and all required PR checks, and inspect each published APK. Browser fixtures make no AO3 requests. Physical-device-only behaviour is reported separately rather than claimed from browser results.

The 3.2 reading migration adds `reading.completed_before` with a default of zero. Existing chapter positions and reading preferences remain intact. Starting again resets current progress atomically while remembering earlier completion; backup merges carry that fact with imported reading positions.
