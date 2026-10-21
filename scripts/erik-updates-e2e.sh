#!/usr/bin/env bash
# Fork-only: end-to-end test of the app updating itself (docs/erik-updates.md).
# Heavy: two release APK builds and an emulator. Run it on the homelab worker,
# never on the PC:
#
#   heavy -e PHASE=build --shell .#android -- scripts/erik-updates-e2e.sh
#   heavy emulator start           (the one shared emulator; check `heavy emulator status`)
#   heavy -e PHASE=device --no-sync --shell .#android -- scripts/erik-updates-e2e.sh
#   heavy pull .erik-updates-e2e
#   heavy emulator stop
#
# Needs one running emulator (API 36 x86_64) on `adb`, and runs inside the
# fork's `.#android` dev shell. Everything is served from this machine; the
# emulator reaches it at 10.0.2.2. It signs with a throwaway key and puts that
# key's certificate into this copy of the repo, so never run it in a checkout
# you commit from, and never with the real key.
#
# Steps, each checked:
#   1. APK A (versionCode 1000) installs and runs its built-in JS.
#   2. A signed JS update is published while the app is open on About: it
#      downloads without a tap and applies once the app leaves the screen.
#   3. APK B (versionCode 1001, a native change) is published while the app is
#      open: it downloads but waits; after Home it installs silently.
# Evidence (logs, screenshots in light and dark mode) lands in $OUT.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$root/.erik-updates-e2e}"
pkg=com.t3tools.t3code.preview
serve="$OUT/serve"
# PHASE=build makes the APKs and updates without touching the emulator (it is
# shared); PHASE=device then runs the checks on what that left in $OUT.
PHASE="${PHASE:-all}"
case "$PHASE" in all | build) rm -rf "$OUT" ;; device) ;; *) echo "PHASE is all, build or device" >&2; exit 2 ;; esac
mkdir -p "$serve/blobs"
cd "$root"

log() { printf '\n== %s %s\n' "$(date +%T)" "$*" | tee -a "$OUT/summary.txt"; }
fingerprint() { # <apk>: the runtime version the APK reports (no unzip in the dev shell)
  local dir
  dir="$(mktemp -d)"
  (cd "$dir" && jar xf "$1" assets/fingerprint && cat assets/fingerprint)
  rm -rf "$dir"
}
fail() {
  log "FAIL: $*"
  adb logcat -d > "$OUT/logcat-fail.txt" 2> /dev/null || true
  adb exec-out screencap -p > "$OUT/fail.png" 2> /dev/null || true
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 && adb shell cat /sdcard/ui.xml > "$OUT/fail-ui.xml" 2> /dev/null || true
  exit 1
}

if [ "$PHASE" != build ]; then
  adb get-state > /dev/null 2>&1 || fail "no emulator on adb (heavy emulator start)"
fi

# --- builds -----------------------------------------------------------------

restore() { :; } # the build phase swaps in test edits and undoes them here
if [ "$PHASE" != device ]; then

unset T3CODE_MOBILE_UPDATES_ENABLED # the dev shell turns updates off
export APP_VARIANT=preview EXPO_NO_GIT_STATUS=1 EXPO_NO_TELEMETRY=1
export T3CODE_MOBILE_UPDATES_URL=http://10.0.2.2:8090/manifest
export T3CODE_MOBILE_SELF_UPDATE_URL=http://10.0.2.2:8091/index.json
export NODE_OPTIONS=--max-old-space-size=4096

CI=true pnpm install --frozen-lockfile --filter=@t3tools/mobile... > "$OUT/install.log" 2>&1

log "throwaway signing key"
(cd apps/mobile && npx expo-updates codesigning:generate --key-output-directory "$OUT/key" \
  --certificate-output-directory "$OUT/cert" --certificate-validity-duration-years 1 \
  --certificate-common-name "erik-updates e2e") > /dev/null
cp "$OUT/cert/certificate.pem" apps/mobile/certs/erik-updates-certificate.pem

about=apps/mobile/src/features/settings/SettingsAboutRouteScreen.tsx
worker=apps/mobile/modules/t3-self-update/android/src/main/java/expo/modules/t3selfupdate/SelfUpdateWorker.kt
cp "$about" "$OUT/about.orig"
cp "$worker" "$OUT/worker.orig"
restore() {
  cp "$OUT/about.orig" "$about"
  cp "$OUT/worker.orig" "$worker"
}
trap restore EXIT

build_apk() { # <versionCode>
  log "build APK $1"
  (
    cd apps/mobile
    npx expo prebuild --clean --platform android --no-install
    cd android
    sed -i -E "s/versionCode [0-9]+/versionCode $1/; s/versionName \"[^\"]*\"/versionName \"2.0.0-erik.test$1\"/" app/build.gradle
    # No daemon: one could outlive the job inside heavy's memory cap.
    ./gradlew assembleRelease --no-daemon --max-workers=2 -PreactNativeArchitectures=x86_64 \
      -Pkotlin.compiler.execution.strategy=in-process "-Dorg.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=1g"
  ) > "$OUT/build-$1.log" 2>&1 || fail "APK $1 build, see build-$1.log"
  cp apps/mobile/android/app/build/outputs/apk/release/app-release.apk "$OUT/$1.apk"
}

build_apk 1000
runtime_a="$(fingerprint "$OUT/1000.apk")"
resolved="$(cd apps/mobile && npx expo-updates runtimeversion:resolve --platform android 2> /dev/null | jq -r .runtimeVersion)"
[ "$runtime_a" = "$resolved" ] || fail "APK runtime $runtime_a != resolved $resolved (CI would never ship JS updates)"
log "APK 1000 runtime $runtime_a matches the resolved one"

log "JS update: About title gets (OTA test)"
sed -i 's/<SettingsScreen title="About T3 Code">/<SettingsScreen title="About T3 Code (OTA test)">/' "$about"
(cd apps/mobile && npx expo export --platform android --output-dir "$OUT/dist" > "$OUT/export.log" 2>&1 &&
  npx expo config --type public --json 2> /dev/null > "$OUT/expo-config.json")
echo '{"apk":null,"runtimes":{}}' > "$OUT/index-ota.json"
node scripts/erik-updates.mjs ota --dist "$OUT/dist" --config "$OUT/expo-config.json" \
  --runtime "$runtime_a" --key "$OUT/key/private-key.pem" --base-url http://10.0.2.2:8091/blobs \
  --index "$OUT/index-ota.json" --blobs "$serve/blobs" --commit e2e-ota

log "native change for APK 1001"
echo "// erik-updates e2e: native change" >> "$worker"
build_apk 1001
cp "$OUT/1001.apk" "$serve/t3code-erik-1001.apk"
cp "$OUT/index-ota.json" "$OUT/index-apk.json"
node scripts/erik-updates.mjs apk --apk "$OUT/1001.apk" --version-code 1001 \
  --version-name 2.0.0-erik.test1001 --runtime "$(fingerprint "$OUT/1001.apk")" \
  --url http://10.0.2.2:8091/t3code-erik-1001.apk --index "$OUT/index-apk.json" --commit e2e-native
restore
echo "$runtime_a" > "$OUT/runtime-1000"
log "builds done"
fi
[ "$PHASE" = build ] && exit 0
[ -f "$OUT/1001.apk" ] || fail "no builds in $OUT (run PHASE=build first)"

# --- servers ----------------------------------------------------------------

echo '{"apk":null,"runtimes":{}}' > "$serve/index.json"
node -e '
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const root = process.argv[1];
http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  console.log(req.method, req.url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.writeHead(200, { "content-length": fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
}).listen(8091, "127.0.0.1");
' "$serve" > "$OUT/files.log" 2>&1 &
files_pid=$!
# The update server as deployed (public homelab repo), unless given.
server_js="${T3_UPDATES_SERVER:-$OUT/server.mjs}"
[ -f "$server_js" ] || curl -fsSL -o "$server_js" \
  https://raw.githubusercontent.com/ErikFrankling/homelab/main/kubernetes/homelab/config/t3-updates/server.mjs
INDEX_URL=http://127.0.0.1:8091/index.json PORT=8090 node "$server_js" > "$OUT/server.log" 2>&1 &
server_pid=$!
trap 'restore; kill $files_pid $server_pid 2> /dev/null || true' EXIT
sleep 2

# --- device helpers ---------------------------------------------------------

dump_ui() { # refresh $OUT/ui.xml from the screen
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
  adb shell cat /sdcard/ui.xml > "$OUT/ui.xml" 2> /dev/null
}
screen_texts() {
  dump_ui
  grep -o 'text="[^"]*"' "$OUT/ui.xml" | sed 's/^text="//; s/"$//' | grep -v '^$'
}
center_of() { # <attribute> <exact value>: "x y" of the first match in ui.xml
  grep -o "$1=\"$2\"[^>]*bounds=\"\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]\"" "$OUT/ui.xml" |
    head -1 | sed -E 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]"/\1 \2 \3 \4/' |
    awk '{ print int(($1 + $3) / 2), int(($2 + $4) / 2) }'
}
tap_on() { # <attribute> <exact value> <seconds>: wait for the element, then tap it
  local deadline=$((SECONDS + $3)) at
  while ((SECONDS < deadline)); do
    dump_ui
    at="$(center_of "$1" "$2")"
    if [ -n "$at" ]; then
      # shellcheck disable=SC2086 # "x y"
      adb shell input tap $at
      return 0
    fi
    sleep 2
  done
  return 1
}
version_code() { adb shell dumpsys package "$pkg" | grep -m1 -o 'versionCode=[0-9]*' | cut -d= -f2; }
launch() {
  adb shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
}
open_about() {
  # The home screen can open with a focused composer; Back hides the keyboard.
  tap_on content-desc "Open settings" 90 || {
    adb shell input keyevent KEYCODE_BACK
    tap_on content-desc "Open settings" 30
  } || fail "no Open settings button on the home screen"
  local found=0
  for _ in 1 2 3 4 5 6 7 8; do
    dump_ui
    if [ -n "$(center_of text "About T3 Code")" ]; then found=1; break; fi
    adb shell input swipe 540 1900 540 700 300
    sleep 1
  done
  [ "$found" = 1 ] || fail "no About T3 Code row in Settings"
  tap_on text "About T3 Code" 10 || fail "could not open About"
  sleep 3
}
wait_log() { # <pattern> <seconds>
  local deadline=$((SECONDS + $2))
  while ((SECONDS < deadline)); do
    adb logcat -d | grep -q "$1" && return 0
    sleep 3
  done
  return 1
}
shoot() { # <name>: light and dark screenshots
  adb exec-out screencap -p > "$OUT/$1-light.png"
  adb shell cmd uimode night yes > /dev/null
  sleep 3
  adb exec-out screencap -p > "$OUT/$1-dark.png"
  adb shell cmd uimode night no > /dev/null
  sleep 2
}

for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
  adb shell settings put global "$setting" 0
done

# --- 1. APK A ---------------------------------------------------------------

log "1. install APK 1000"
adb uninstall "$pkg" > /dev/null 2>&1 || true
adb install "$OUT/1000.apk" > /dev/null
# On the phone this is Erik's one-time "Install unknown apps" tap.
adb shell appops set "$pkg" REQUEST_INSTALL_PACKAGES allow
adb logcat -c
launch
open_about
screen_texts > "$OUT/1-about.txt"
grep -qx "About T3 Code" "$OUT/1-about.txt" || fail "APK 1000 does not show its built-in About"
grep -q "erik.test1000" "$OUT/1-about.txt" || fail "About does not show the native build"
shoot 1-about

# --- 2. JS update -----------------------------------------------------------

log "2. publish the JS update while the app is open"
adb logcat -c
cp "$OUT/index-ota.json" "$serve/index.json"
start=$SECONDS
wait_log "DownloadCompleteWithUpdate" 120 || fail "JS update not downloaded within 120 s"
log "JS update downloaded after $((SECONDS - start)) s, no tap"
adb logcat -c
adb shell input keyevent KEYCODE_HOME
wait_log "Updates state change: Restart" 60 || fail "JS update not applied after leaving the app"
log "JS update applied in the background"
launch
open_about
screen_texts > "$OUT/2-about.txt"
grep -qx "About T3 Code (OTA test)" "$OUT/2-about.txt" || fail "new JS not running"
grep -q "JS " "$OUT/2-about.txt" || fail "About does not show the JS update"
shoot 2-about-after-ota

# --- 3. native update -------------------------------------------------------

log "3. publish APK 1001 while the app is open"
adb logcat -c
cp "$OUT/index-apk.json" "$serve/index.json"
wait_log "downloaded; waiting until the app is off screen" 150 || fail "APK 1001 not downloaded within 150 s"
[ "$(version_code)" = 1000 ] || fail "installed while the app was on screen"
log "APK 1001 downloaded and held while the app is on screen"
adb shell input keyevent KEYCODE_HOME
start=$SECONDS
while [ "$(version_code)" != 1001 ] && ((SECONDS - start < 90)); do sleep 3; done
[ "$(version_code)" = 1001 ] || fail "APK 1001 not installed within 90 s of leaving the app"
log "APK 1001 installed $((SECONDS - start)) s after leaving the app"
adb shell dumpsys package "$pkg" | grep -E 'versionCode|versionName|installerPackageName|lastUpdateTime' | tee -a "$OUT/summary.txt"
if adb shell dumpsys notification --noredact | grep -q t3-app-updates; then
  fail "Android asked for a confirmation (update notification posted)"
fi
log "no confirmation asked"
adb logcat -d -s T3SelfUpdate > "$OUT/self-update.log"
launch
open_about
screen_texts > "$OUT/3-about.txt"
grep -q "erik.test1001" "$OUT/3-about.txt" || fail "About does not show build 1001"
shoot 3-about-after-apk

log "PASS"
