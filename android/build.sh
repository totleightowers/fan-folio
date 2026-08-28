#!/bin/bash
# Build the Archive APK on the phone itself.
#
# Needs: aapt2, d8, apksigner, javac (JDK 17+), zip, node 20+, and an
# android.jar (API 34) at sdk/android.jar.
set -euo pipefail
cd "$(dirname "$0")"

SDK_JAR="${SDK_JAR:-sdk/android.jar}"
KEYSTORE="${KEYSTORE:-keystore.jks}"
KEYSTORE_PASS="${KEYSTORE_PASS:-changeit}"
KEY_ALIAS="${KEY_ALIAS:-fanfolio}"
OUT="${OUT:-fanfolio.apk}"

[ -f "$SDK_JAR" ] || { echo "missing $SDK_JAR (API 34 android.jar)" >&2; exit 1; }

echo "1/7  bundle the web app"
VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo v0.0.0)"
VERSION="${VERSION#v}"
VERSION_CODE="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
echo "stamping version $VERSION ($VERSION_CODE)"

rm -rf assets/web build && mkdir -p assets/web build/compiled build/classes build/gen
cp -r ../app/. assets/web/
# the vendored AO3 sources are build inputs, not app assets
rm -rf assets/web/vendor

# The version, written where the page can simply read it.
#
# Four attempts went into getting it out of the package metadata instead —
# manifest attribute, aapt2 --version-name, a generated manifest — and the
# package kept reporting 0.1 whatever was done. This is one line, it is
# generated from the tag on every build, and nothing can quietly override it.
printf '%s' "$VERSION" > assets/web/version.txt

# The merge steps, emitted from the module the tests exercise. The shell cannot
# import JavaScript and a hand-copied second version would drift from the one
# under test, so the tested statements travel with the app instead.
node ../tools/emit-merge-sql.mjs > assets/web/merge.sql

echo "2/7  compile resources"
aapt2 compile --dir res -o build/compiled/res.zip

echo "3/7  link resources, manifest and assets"
# The release is named by its tag, so that is what the package is stamped with.
# Four places used to declare a version — the page, the manifest, package.json
# and the tag — and they had drifted to four different answers.
# Written into a copy of the manifest rather than passed as a flag. aapt2's
# --version-name is only a default: an attribute in the manifest beats it, and
# with no attribute at all the flag still did not take — the package kept
# saying 0.1 through three attempts at this. An attribute is the one thing that
# demonstrably decides it, so the build generates one.
mkdir -p build
sed "s|package=\"org.fanfolio\">|package=\"org.fanfolio\" android:versionCode=\"$VERSION_CODE\" android:versionName=\"$VERSION\">|" \
  AndroidManifest.xml > build/AndroidManifest.xml
grep -q "android:versionName=\"$VERSION\"" build/AndroidManifest.xml \
  || { echo "could not stamp the version into the manifest" >&2; exit 1; }

aapt2 link -I "$SDK_JAR" --manifest build/AndroidManifest.xml -o build/base.apk \
  --java build/gen -A assets --min-sdk-version 24 --target-sdk-version 34 \
  build/compiled/res.zip

echo "4/7  compile java"
find src build/gen -name '*.java' > build/sources.txt
# errors must not be swallowed: a hidden compile failure once produced a
# "successful" build that silently shipped the previous APK
javac -nowarn -source 8 -target 8 -bootclasspath "$SDK_JAR" \
  -classpath "$SDK_JAR" -d build/classes @build/sources.txt 2>&1 \
  | grep -v 'bootstrap class path\|source value 8\|target value 8\|deprecat' || true
[ -n "$(find build/classes -name '*.class' -print -quit)" ] || {
  echo "javac produced no classes — build failed" >&2; exit 1; }

echo "5/7  dex"
d8 --min-api 24 --lib "$SDK_JAR" --output build $(find build/classes -name '*.class')

echo "6/7  package and align"
cp build/base.apk build/unsigned.apk
(cd build && zip -q -X unsigned.apk classes.dex)
# Android refuses to install an APK whose resources.arsc is not 4-byte aligned
node zipalign.mjs build/unsigned.apk build/aligned.apk

echo "7/7  sign"
if [ ! -f "$KEYSTORE" ]; then
  echo "     generating $KEYSTORE — keep it, updates must use the same key"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" \
    -keypass "$KEYSTORE_PASS" -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=Fan Folio, O=Personal, C=GB" >/dev/null 2>&1
fi
rm -f "$OUT"
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" \
  --key-pass "pass:$KEYSTORE_PASS" --ks-key-alias "$KEY_ALIAS" \
  --out "$OUT" build/aligned.apk

echo
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
