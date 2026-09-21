# v3 feature rollout

The UI assessment is accepted for implementation. Each feature receives its own signed commits, PR, checked integration and release before the next feature begins. The v2.10.4 source and APK stay frozen.

| Release | Feature | Status |
|---|---|---|
| 3.0.0 | Home / Library / Downloads navigation; account in Settings; collection shortcuts; unified Add entry | [Released](https://github.com/totleightowers/fan-folio/releases/tag/v3.0.0), [PR #186](https://github.com/totleightowers/fan-folio/pull/186) |
| 3.1.0 | Explicit search scope and reliable query/return state | [Released](https://github.com/totleightowers/fan-folio/releases/tag/v3.1.0), [PR #187](https://github.com/totleightowers/fan-folio/pull/187) |
| 3.2.0 | Direct resume, reading state and work-page priorities | [Released](https://github.com/totleightowers/fan-folio/releases/tag/v3.2.0), [PR #188](https://github.com/totleightowers/fan-folio/pull/188) |
| 3.3.0 | Coherent Library presentation and filters | [Released](https://github.com/totleightowers/fan-folio/releases/tag/v3.3.0), [PR #189](https://github.com/totleightowers/fan-folio/pull/189) |
| 3.4.0 | Download progress and author management journeys | [Released](https://github.com/totleightowers/fan-folio/releases/tag/v3.4.0), [PR #190](https://github.com/totleightowers/fan-folio/pull/190) |
| 3.5.0 | Reader controls, settings and final journey/accessibility pass | [Release](https://github.com/totleightowers/fan-folio/releases/tag/v3.5.0) |

The first six releases were the initial pass. The broader redesign follows:

| Release | Feature | Delivery |
|---|---|---|
| 3.5.1 | Saved-copy availability and consistent archive handoff | [Release](https://github.com/totleightowers/fan-folio/releases/tag/v3.5.1), [PR #192](https://github.com/totleightowers/fan-folio/pull/192) |
| 3.6.0 | Individual, persisted download-job results | [Release](https://github.com/totleightowers/fan-folio/releases/tag/v3.6.0), [PR #193](https://github.com/totleightowers/fan-folio/pull/193) |
| 3.7.0 | Reading desk, full-screen tablet reading, persistent return and new folio icon | [Release](https://github.com/totleightowers/fan-folio/releases/tag/v3.7.0), [PR #196](https://github.com/totleightowers/fan-folio/pull/196) |
| 3.8.0 | Collection previews and preserved return journeys | [PR #197](https://github.com/totleightowers/fan-folio/pull/197) |
| 3.9.0 | Focused Settings destinations and contextual story search | Final implementation slice |

The Android package and signing key are retained. Validate each changed journey in browser fixtures at phone and tablet sizes, run the applicable logic/native checks and all required PR checks, and inspect each published APK. Browser fixtures make no AO3 requests. Physical-device-only behaviour is reported separately rather than claimed from browser results.

The 3.2 reading migration adds `reading.completed_before` with a default of zero. Existing chapter positions and reading preferences remain intact. Starting again resets current progress atomically while remembering earlier completion; backup merges carry that fact with imported reading positions.

The completed capability mapping and verification limits are recorded in [v3 journey validation](v3-validation.md).
