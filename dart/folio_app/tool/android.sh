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
# a plugin that wants a newer one fails the build with a paragraph about it.
# Raising compileSdk is not raising targetSdk or minSdk: it says which APIs may
# be referenced, not which behaviour the app opts in to or which phones it runs
# on, so it costs nothing here.
sed -i 's/compileSdk = flutter.compileSdkVersion/compileSdk = 36/' "$gradle"
sed -i 's/compileSdkVersion flutter.compileSdkVersion/compileSdkVersion 36/' "$gradle"

# Labelled as what it is, so two Fan Folios on one phone can be told apart.
manifest=android/app/src/main/AndroidManifest.xml
if [ "$APP_ID" != "org.fanfolio" ]; then
  sed -i 's/android:label="[^"]*"/android:label="Fan Folio 2"/' "$manifest"
fi

grep -n "applicationId" "$gradle"
