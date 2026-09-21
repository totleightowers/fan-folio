# Fan Folio version tracks

## Frozen v2 experience

**v2.10.4 is the preserved v2 UI.**

- [Download the Android APK](https://github.com/totleightowers/fan-folio/releases/download/v2.10.4/fanfolio.apk)
- [Release page](https://github.com/totleightowers/fan-folio/releases/tag/v2.10.4)
- [Frozen source branch](https://github.com/totleightowers/fan-folio/tree/frozen/v2)
- Commit: `7561274c93b37483d15e2f35604db57543a27904`
- APK SHA-256: `b815d865b01e563f1e175473ba78387522afa012efb8183dbd1491a3b42bc76d`

The `frozen/v2` branch is protected against updates and deletion, with no bypass actors. Keep the signed `v2.10.4` tag and its existing release asset. Do not replace that APK with a rebuild or direct readers only to the moving “latest” release link.

No v3 UI work goes into this baseline. Any later maintenance decision must leave this exact version and its download available.

## New v3 experience

The separate `v3` branch begins at v2.10.4. Its first work is the [UI and journey assessment](v3-ui-assessment.md), with documentation and baseline screenshots only. `main` remains at the v2 baseline during this assessment.

The redesigned experience belongs to major version **3**, with its first stable release intended as **3.0.0**. There is no v3 APK or release tag yet. APK versions are derived from release tags; starting the design branch does not require shipping a renamed copy of v2.

Before a v3 build is distributed, decide its Android package/install relationship to v2 and verify backup/import and database compatibility. A downloadable old APK is not a promise that Android can downgrade a later installation or that an older app can read a newer database.

Commits and tags must be signed with the owner's key. When v3 is eventually integrated, preserve those signed commits; do not squash or use a server-side rebase that rewrites them.
