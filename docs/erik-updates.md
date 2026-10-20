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

## Testing

Run the workflow on a branch with another channel, so nothing reaches the
phone:

```sh
gh workflow run erik-android.yml -R ErikFrankling/t3code --ref <branch> \
  -f channel=android-ota-test -f abis=x86_64 -f apk=true \
  -f updates_url=http://10.0.2.2:8090/manifest
```

On the PC, serve that channel to the emulator:

```sh
INDEX_URL=https://github.com/ErikFrankling/t3code/releases/download/android-ota-test/index.json \
  PORT=8090 node ~/projects/personal/homelab/kubernetes/homelab/config/t3-updates/server.mjs
```

Install the APK with `adb install`, then allow self-updates with
`adb shell appops set com.t3tools.t3code.preview REQUEST_INSTALL_PACKAGES allow`
(on the phone this is the one-time tap). Push a JS change and run the
workflow again without `apk=true`; push a native change and the app installs
the new APK once it is backgrounded. `adb logcat -s T3SelfUpdate` shows each
step. Delete the test release afterwards.
