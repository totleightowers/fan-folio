#!/bin/bash
# Generate the Android scaffold, then make it ours.
#
# `flutter create` writes gradle files, a manifest and a host Activity. Those
# are generated, not authored, so they are not kept in the repository — a
# hand-maintained copy drifts from what the installed Flutter expects, and the
# failure is a build that works on one machine.
#
# What is ours is the application id and the label, and those are applied here
# afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_ID="${APP_ID:-org.fanfolio.next}"

echo "scaffolding android for $APP_ID"
flutter create --platforms=android --org org.fanfolio --project-name folio_app .

# The id decides whether this replaces the 1.x app or sits beside it. An alpha
# sits beside it: testing an unfinished 2.x must never take somebody's working
# library off their phone.
gradle=android/app/build.gradle.kts
[ -f "$gradle" ] || gradle=android/app/build.gradle
sed -i "s/applicationId = \"[^\"]*\"/applicationId = \"$APP_ID\"/" "$gradle"
sed -i "s/applicationId \"[^\"]*\"/applicationId \"$APP_ID\"/" "$gradle"

# Compiled against a new enough Android to satisfy the plugins.
#
# flutter.compileSdkVersion is whatever the installed Flutter defaults to, and
# a plugin wanting a newer one fails the build with a paragraph about it. It is
# not the app's own setting that matters — each plugin is its own gradle module
# with its own — so every subproject is told, not just this one.
#
# Raising compileSdk is not raising targetSdk or minSdk: it says which APIs may
# be referenced, not which behaviour the app opts in to or which phones it runs
# on, so it costs nothing here.
SDK=36
sed -i "s/compileSdk = flutter.compileSdkVersion/compileSdk = $SDK/" "$gradle"
sed -i "s/compileSdkVersion flutter.compileSdkVersion/compileSdkVersion $SDK/" "$gradle"

# Prepended, not appended.
#
# Flutter's own root script ends by making every subproject depend on :app for
# evaluation, which evaluates them there and then — so a block registered after
# it is registering afterEvaluate on a project that has already been evaluated,
# and gradle says so and stops. This has to be in place before that line runs.
root=android/build.gradle.kts
if [ -f "$root" ]; then
  cat > /tmp/folio-root.kts <<KTS
// Every plugin module, not only this app: a plugin brought in by another
// plugin carries its own compileSdk, and one of them being older than the rest
// fails the whole build.
subprojects {
    afterEvaluate {
        extensions.findByName("android")?.let { ext ->
            (ext as com.android.build.gradle.BaseExtension).compileSdkVersion($SDK)
        }
    }
}

KTS
  cat "$root" >> /tmp/folio-root.kts
  mv /tmp/folio-root.kts "$root"
else
  root=android/build.gradle
  cat > /tmp/folio-root.gradle <<GROOVY
// Every plugin module, not only this app.
subprojects {
    afterEvaluate { p ->
        if (p.hasProperty('android')) {
            p.android { compileSdkVersion $SDK }
        }
    }
}

GROOVY
  cat "$root" >> /tmp/folio-root.gradle
  mv /tmp/folio-root.gradle "$root"
fi
head -12 "$root"

# Labelled as what it is, so two Fan Folios on one phone can be told apart.
manifest=android/app/src/main/AndroidManifest.xml
if [ "$APP_ID" != "org.fanfolio" ]; then
  sed -i 's/android:label="[^"]*"/android:label="Fan Folio 2"/' "$manifest"
fi

grep -n "applicationId" "$gradle"
