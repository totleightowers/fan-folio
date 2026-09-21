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

The next major version is **3**. It is implemented in feature slices, each with a reviewed pull request, checks and a release. See the [rollout record](v3-rollout.md). `main` carries released work; `v3` follows the new major. The original [assessment](v3-ui-assessment.md) records the v2 baseline and design rationale.

v3 uses the same Android package and signing key as v2, so it updates the installed app and retains its data. The first navigation release changes no database schema or stored reading settings. The preserved v2 APK remains available; reinstalling an older APK over a later installation is not a supported downgrade path. Keep a library backup when switching installations.

Commits and tags must be signed with the owner's key. When v3 is eventually integrated, preserve those signed commits; do not squash or use a server-side rebase that rewrites them.
