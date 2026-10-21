# Erik's Android app updates itself

Fork-only. Every push to `erik/main` reaches the phone without a tap, whether
it changed JavaScript or native code.

## How a release arrives

1. `.github/workflows/erik-android.yml` resolves the app's runtime version
   (Expo's native fingerprint) and compares it with the newest APK's.
2. **Same fingerprint, JS-only change (about 5 minutes):** `expo export`, then
   `scripts/erik-updates.mjs ota` writes a manifest signed with the fork's key
   (secret `ERIK_UPDATES_PRIVATE_KEY`, certificate
   `apps/mobile/certs/erik-updates-certificate.pem`) into `index.json`.
3. **Native change (about 25 minutes):** a signed APK, recorded in `index.json`
   as `apk`, and also published as a normal `android-v…` release.
4. Everything lives on the rolling prerelease `android-ota`: `index.json` plus
   content-addressed bundles and assets. `scripts/erik-updates-release.sh`
   swaps the index in place and prunes files nothing references.

On the phone:

- **JS updates** come through expo-updates from
  `https://t3-updates.erikfrankling.duckdns.org/manifest`, a stateless server
  in the homelab repo (`kubernetes/homelab/apps/t3-updates.yaml`) that turns
  `index.json` into the expo-updates protocol. The app only accepts manifests
  signed by the fork's key, so upstream's EAS updates can never load.
- **APKs** come from `modules/t3-self-update`: it reads `index.json` straight
  from GitHub, downloads a newer APK, checks its SHA-256 and package, and
  installs it with `PackageInstaller` and `USER_ACTION_NOT_REQUIRED`.
  Android 12+ lets an app update itself without asking.
- While the app is open it checks every minute
  (`src/features/updates/erik-auto-update.ts`). A downloaded update is applied
  the next time the app leaves the screen: JS reloads, an APK installs. It
  never restarts the app on screen or during voice mode (a foreground
  service). If the app stays open for 30 minutes with a JS update ready, it
  offers to install it.
- While the app is closed, WorkManager checks for APKs every 15 minutes, which
  is Android's minimum. JS updates are fetched when the app starts.
- Settings → About → Version shows the running build and JS update.

## The one-time tap

On Android 14+ Obtainium installs apps with _update ownership_, so the app's
first self-update shows Android's "update from a different source?" prompt.
The app also needs **Install unknown apps** allowed once. Both appear as one
notification, "T3 Code update ready". After they are confirmed, Android
clears Obtainium's ownership and later updates install silently. Obtainium is
no longer needed for this app.

## What is not push-triggered

The phone notices a release within about a minute while the app is open, or
within 15 minutes (WorkManager, later in Doze) while it is closed. Waking a
closed app the moment CI finishes needs a push service: FCM (a Firebase
project with `google-services.json`, see `docs/operations/android-notifications.md`)
or UnifiedPush through the ntfy app. Neither exists yet.

## Never a rollback

Installed apps take whatever `index.json` offers, and a version code only
records when a build ran. So the workflow runs only on `erik/main`, and
`scripts/erik-updates-guard.sh` checks content before publishing anything:

- the commit must still be the tip of `erik/main`, or the run publishes
  nothing (the newer run does);
- every commit already shipped (the newest `android-v…` release and every
  entry in `index.json`) must be in it, as an ancestor or, after the nightly
  rebase, as an equivalent patch (`git cherry`). Otherwise the run fails and
  lists the missing commits.

If commits were removed from `erik/main` on purpose, run the workflow by hand
on `erik/main` with `accept_dropped_commits`.

## Testing

Never run the workflow on a branch. Test with local builds on the emulator,
all served from the PC:

1. Serve a local channel: `index.json`, bundles and APKs in one directory over
   HTTP (port 8091), and the update server on 8090:
   `INDEX_URL=http://127.0.0.1:8091/index.json PORT=8090 node <homelab>/kubernetes/homelab/config/t3-updates/server.mjs`.
2. Build a release APK with `APP_VARIANT=preview`,
   `T3CODE_MOBILE_UPDATES_URL=http://10.0.2.2:8090/manifest` and
   `T3CODE_MOBILE_SELF_UPDATE_URL=http://10.0.2.2:8091/index.json`
   (`expo prebuild`, then `./gradlew assembleRelease -PreactNativeArchitectures=x86_64`
   with a set `versionCode`). Install it with `adb install`, then
   `adb shell appops set com.t3tools.t3code.preview REQUEST_INSTALL_PACKAGES allow`
   (on the phone, that is the one-time tap).
3. JS update: change JS, `expo export --platform android`, then
   `scripts/erik-updates.mjs ota` with the APK's runtime
   (`unzip -p app.apk assets/fingerprint`) into the local index.
4. Native update: change native code, build again with a higher
   `versionCode`, and record it with `scripts/erik-updates.mjs apk`.
5. `adb logcat -s T3SelfUpdate` shows each step; Settings → About → Version
   shows what is running.
