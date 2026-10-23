#!/usr/bin/env bash
# Fork-only: build and publish the Android release of the checked-out commit
# of erik/main (docs/erik-updates.md). The one implementation of a release:
# `.github/workflows/erik-android.yml` runs it, and so does `t3-android-release`
# (dotfiles) on the homelab when GitHub Actions is unavailable.
#
# Run at the root of a full clone (the guard needs history) with dependencies
# installed (`pnpm install --filter=@t3tools/mobile...`), node, pnpm, jq, gh,
# unzip or jar, JDK 17 and an Android SDK in ANDROID_HOME.
#
# Env:
#   GH_TOKEN                          gh token with contents: write on GH_REPO
#   GH_REPO                           default ErikFrankling/t3code
#   GOOGLE_SERVICES_JSON              Firebase config (FCM push)
#   ERIK_UPDATES_PRIVATE_KEY          JS update signing key (PEM)
#   ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS
#   T3CODE_FCM_SERVICE_ACCOUNT_JSON   optional: release ping to installed apps
#   FORCE_APK=true                    build an APK even if a JS update would do
#   ACCEPT_DROPPED_COMMITS=true       see scripts/erik-updates-guard.sh
#   ALLOW_BEHIND_TIP=true             publish even if erik/main moved on meanwhile (no
#                                     newer run will; set by t3-android-release)
#   GRADLE_ARGS                       extra Gradle arguments (worker limits)
#   PREBUILT_APK                      publish this signed APK (built by an earlier run
#                                     from the same commit) instead of building
#   JS_ONLY=true                      stop (exit 3) instead of building an APK
#   EXTRA_TEST_ABI                    also build an unpublished APK for this ABI
#                                     (e.g. x86_64, for an emulator check)
#   OUT                               where to leave the APKs (default: a temp dir)
set -euo pipefail

export GH_REPO="${GH_REPO:-ErikFrankling/t3code}"
export APP_VARIANT=preview
export CHANNEL=android-ota
# Updates come only from Erik's server and must carry the fork's signature
# (apps/mobile/certs), so upstream's EAS updates never load.
export T3CODE_MOBILE_UPDATES_URL=https://t3-updates.erikfrankling.duckdns.org/manifest
export T3CODE_MOBILE_SELF_UPDATE_URL="https://github.com/$GH_REPO/releases/download/$CHANNEL/index.json"
export T3CODE_ANDROID_GOOGLE_SERVICES_FILE=./google-services.json
export EXPO_NO_GIT_STATUS=1 EXPO_NO_TELEMETRY=1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
# The fork's Nix dev shell turns OTA updates off for local development.
unset T3CODE_MOBILE_UPDATES_ENABLED

root="$(git rev-parse --show-toplevel)"
cd "$root"
sha="$(git rev-parse HEAD)"
work="$(mktemp -d)"
OUT="${OUT:-$work/out}"
mkdir -p "$OUT"
cleanup() { rm -rf "$work/keys"; }
trap cleanup EXIT
mkdir -m 700 "$work/keys"

step() { printf '\n== %s %s\n' "$(date -u +%T)" "$*"; }
fingerprint() { # <apk>: the runtime version the APK reports
  if command -v unzip > /dev/null; then
    unzip -p "$1" assets/fingerprint
  else
    (cd "$work" && rm -rf assets && jar xf "$1" assets/fingerprint && cat assets/fingerprint)
  fi
}

step "Firebase config"
# Without it the APK builds fine but can never receive push: fail instead.
[ -n "${GOOGLE_SERVICES_JSON:-}" ] || { echo "GOOGLE_SERVICES_JSON is not set" >&2; exit 1; }
printf '%s\n' "$GOOGLE_SERVICES_JSON" > apps/mobile/google-services.json
jq -e '.client[].client_info.android_client_info.package_name == "com.t3tools.t3code.preview"' \
  apps/mobile/google-services.json > /dev/null

step "Plan ${sha::7}"
scripts/erik-updates-release.sh ensure "$CHANNEL"
scripts/erik-updates-release.sh fetch "$CHANNEL" "$work/index.json"
runtime="$(cd apps/mobile && npx expo-updates runtimeversion:resolve --platform android 2> /dev/null | jq -r .runtimeVersion)"
installed="$(jq -r '.apk.runtimeVersion // ""' "$work/index.json")"
echo "runtime $runtime, newest APK runtime ${installed:-none}"
# Fails if this commit lacks shipped work; stops quietly if erik/main moved on.
decision="$(scripts/erik-updates-guard.sh "$work/index.json")"
if [ "$decision" != publish=true ]; then
  echo "kind=none"
  exit 0
elif [ -n "$runtime" ] && [ "$runtime" = "$installed" ] && [ "${FORCE_APK:-false}" != true ]; then
  kind=ota
else
  kind=apk
fi
echo "kind=$kind"
if [ "$kind" = apk ] && [ "${JS_ONLY:-false}" = true ]; then
  echo "this release needs an APK; JS_ONLY is set, so nothing was built or published" >&2
  exit 3
fi

guard_again() { # erik/main or the index may have moved while this built
  # Publish on top of the live index, never the copy fetched at the start:
  # an older build must not replace a release published meanwhile.
  scripts/erik-updates-release.sh fetch "$CHANNEL" "$work/index.json"
  [ "$(scripts/erik-updates-guard.sh "$work/index.json")" = publish=true ]
}

if [ "$kind" = ota ]; then
  step "Export JS update"
  (
    cd apps/mobile
    npx expo export --platform android --output-dir "$work/dist"
    npx expo config --type public --json 2> /dev/null > "$work/expo-config.json"
  )
  jq -e '.updates.url == env.T3CODE_MOBILE_UPDATES_URL' "$work/expo-config.json" > /dev/null

  step "Publish JS update"
  guard_again || { echo "erik/main moved on; nothing published"; exit 0; }
  printf '%s\n' "$ERIK_UPDATES_PRIVATE_KEY" > "$work/keys/updates-key.pem"
  node scripts/erik-updates.mjs ota --dist "$work/dist" \
    --config "$work/expo-config.json" --runtime "$runtime" \
    --key "$work/keys/updates-key.pem" --base-url "https://github.com/$GH_REPO/releases/download/$CHANNEL" \
    --index "$work/index.json" --blobs "$work/blobs" --commit "$sha"
  rm "$work/keys/updates-key.pem"
  scripts/erik-updates-release.sh upload "$CHANNEL" "$work"/blobs/*
  scripts/erik-updates-release.sh index "$CHANNEL" "$work/index.json"
  scripts/erik-updates-release.sh prune "$CHANNEL" "$work/index.json"
  jq -r --arg rt "$runtime" '"published JS update \(.runtimes[$rt].id) for runtime \($rt)"' "$work/index.json"
  exit 0
fi

base="$(sed -nE 's/.*T3CODE_MOBILE_VERSION \?\? "([^"]+)".*/\1/p' apps/mobile/app.config.ts | head -1)"
# Android only installs an update with a higher versionCode.
code="$(($(date +%s) / 60))"
name="${base}-erik.$(date -u +%Y%m%d%H%M).${sha::7}"

prebuild() {
  step "Prebuild"
  (
    cd apps/mobile
    npx expo prebuild --clean --platform android --no-install
    manifest=android/app/src/main/AndroidManifest.xml
    grep -qF "android:name=\"expo.modules.updates.EXPO_UPDATE_URL\" android:value=\"$T3CODE_MOBILE_UPDATES_URL\"" "$manifest"
    grep -q 'expo.modules.updates.CODE_SIGNING_CERTIFICATE' "$manifest"
  )
}

build_tools="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
printf '%s' "$ANDROID_KEYSTORE_B64" | base64 -d > "$work/keys/release.jks"
build_and_sign() { # <abis> <out.apk>
  step "Build $name ($code) for $1"
  (
    cd apps/mobile/android
    sed -i -E "s/versionCode [0-9]+/versionCode $code/; s/versionName \"[^\"]*\"/versionName \"$name\"/" app/build.gradle
    # shellcheck disable=SC2086 # GRADLE_ARGS is a list of arguments
    ./gradlew assembleRelease --no-daemon -PreactNativeArchitectures="$1" ${GRADLE_ARGS:-}
  )
  step "Sign"
  "$build_tools/zipalign" -f -p 4 \
    apps/mobile/android/app/build/outputs/apk/release/app-release.apk "$work/aligned.apk"
  "$build_tools/apksigner" sign --ks "$work/keys/release.jks" \
    --ks-pass env:ANDROID_KEYSTORE_PASSWORD --ks-key-alias "$ANDROID_KEY_ALIAS" \
    --out "$2" "$work/aligned.apk"
  "$build_tools/apksigner" verify "$2"
  # Without it the microphone button records nothing (an upstream plugin
  # option once removed it); without the other two the app cannot update itself.
  local permissions
  permissions="$("$build_tools/aapt2" dump permissions "$2")"
  for permission in RECORD_AUDIO REQUEST_INSTALL_PACKAGES UPDATE_PACKAGES_WITHOUT_USER_ACTION; do
    grep -q "$permission" <<< "$permissions" || { echo "APK lacks $permission" >&2; exit 1; }
  done
}

if [ -n "${PREBUILT_APK:-}" ]; then
  # An APK an earlier run built from this commit but could not publish.
  step "Prebuilt $PREBUILT_APK"
  badging="$("$build_tools/aapt2" dump badging "$PREBUILT_APK")"
  code="$(sed -nE "s/.*versionCode='([0-9]+)'.*/\1/p" <<< "$badging" | head -1)"
  name="$(sed -nE "s/.*versionName='([^']+)'.*/\1/p" <<< "$badging" | head -1)"
  [[ "$name" == *".${sha::7}" ]] || { echo "$PREBUILT_APK ($name) was not built from ${sha::7}" >&2; exit 1; }
  "$build_tools/apksigner" verify "$PREBUILT_APK"
  apk="$OUT/t3code-erik-$code.apk"
  cp "$PREBUILT_APK" "$apk"
else
  prebuild
  apk="$OUT/t3code-erik-$code.apk"
  build_and_sign arm64-v8a "$apk"
fi
apk_runtime="$(fingerprint "$apk")"
[ "$apk_runtime" = "$runtime" ] ||
  echo "warning: APK runtime $apk_runtime differs from the resolved $runtime; JS updates will build APKs until they agree" >&2

step "Publish APK $name"
guard_again || { echo "erik/main moved on; nothing published"; exit 0; }
scripts/erik-updates-release.sh upload "$CHANNEL" "$apk"
node scripts/erik-updates.mjs apk --apk "$apk" --version-code "$code" \
  --version-name "$name" --runtime "$apk_runtime" --commit "$sha" \
  --url "https://github.com/$GH_REPO/releases/download/$CHANNEL/$(basename "$apk")" \
  --index "$work/index.json"
scripts/erik-updates-release.sh index "$CHANNEL" "$work/index.json"
scripts/erik-updates-release.sh prune "$CHANNEL" "$work/index.json"
# Also a normal release, for history and for a fresh install.
cp "$apk" "$work/t3code-erik.apk"
gh release create "android-v$name" "$work/t3code-erik.apk" \
  --target "$sha" --title "Android $name" --latest \
  --notes "Android build of erik/main at ${sha::7}. Installed apps update themselves; see docs/erik-updates.md."
# Keep the five newest builds.
gh release list --limit 100 --json tagName,createdAt \
  --jq '[.[] | select(.tagName | startswith("android-v"))] | sort_by(.createdAt) | reverse | .[5:] | .[].tagName' |
  while read -r old; do gh release delete "$old" --cleanup-tag --yes; done
echo "published APK $name ($code), runtime $apk_runtime"

if [ -n "${T3CODE_FCM_SERVICE_ACCOUNT_JSON:-}" ]; then
  # Installed apps would notice within 15 minutes; this makes it seconds.
  step "Ping installed apps"
  node scripts/erik-updates-ping.mjs || echo "warning: release ping failed; apps still poll" >&2
fi

if [ -n "${EXTRA_TEST_ABI:-}" ] && [ -z "${PREBUILT_APK:-}" ]; then
  # Same commit, version and key, for an emulator; never published. Built
  # after publishing so it never delays the release.
  build_and_sign "$EXTRA_TEST_ABI" "$OUT/t3code-erik-$code-$EXTRA_TEST_ABI.apk"
fi
rm -f "$work/keys/release.jks"
