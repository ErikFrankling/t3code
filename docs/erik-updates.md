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
The app also needs **Install unknown apps** allowed once. When Android asks,
the app shows the prompt if it is on screen, or posts a "T3 Code update
ready" notification that opens it. After that, Android clears Obtainium's
ownership (AOSP `InstallPackageHelper`: "Once the installer changes and users
agree to proceed, clear the update owner") and later updates install silently. Obtainium is
no longer needed for this app.

## Push: a release reaches a closed app in seconds

After publishing an APK, CI sends a content-free, high-priority FCM data
message to the `erik-updates` topic (`scripts/erik-updates-ping.mjs`, secret
`T3CODE_FCM_SERVICE_ACCOUNT_JSON`, Firebase project `t3code-erik-push`).
`t3-agent-notifications` subscribes to the topic and turns the ping into the
broadcast `<package>.T3_SELF_UPDATE_CHECK`; `UpdatePingReceiver` in
`t3-self-update` then runs the same check as leaving the app. Anyone with the
APK's `google-services.json` can subscribe to the topic, so the message never
carries anything but the ping. Without the ping (no Google Play services, or
FCM deprioritising data-only messages) the 15-minute WorkManager poll still
applies, and an open app checks every minute.

## When GitHub Actions is unavailable

The release is one script, `scripts/erik-android-release.sh`, which the workflow
runs. When Actions is down (e.g. "HTTP 422: Actions has been disabled for this
repository"), run it on the homelab from the PC with `t3-android-release`
(dotfiles, `modules/home-manager/t3-android-release`): it takes the same
secrets from sops, clones `erik/main` on the agent worker through `heavy`, and
publishes exactly what the workflow would (JS update or APK, `index.json`, the
`android-v…` release for Obtainium, the FCM ping). Publishing only needs the
GitHub API, not Actions. `--apk` forces an APK; `--test-abi x86_64` also builds
an unpublished x86_64 copy of the same release for an emulator check. Never run
it while a workflow run is in progress.

## Runtime versions

A JS update only reaches APKs with the same runtime version, Expo's native
fingerprint. CI resolves it before building and the APK records it while
building (`assets/fingerprint`), so the two must agree:
`apps/mobile/.fingerprintignore` leaves out the Kotlin daemon's session files
that Gradle writes into the expo-updates plugin directory mid-build. If they
ever differ, the APK step warns and every push builds an APK, which is slow
but safe. Do not build test APKs inside `nix develop .#android` without
unsetting `T3CODE_MOBILE_UPDATES_ENABLED`: the dev shell turns updates off.

## Never a rollback

Installed apps take whatever `index.json` offers, and a version code only
records when a build ran. So the workflow runs only on `erik/main`, and
`scripts/erik-updates-guard.sh` checks content before publishing anything:

- the commit must still be the tip of `erik/main`, or the run publishes
  nothing (the newer run does);
- every commit already shipped (the newest `android-v…` release and every
  entry in `index.json`) must be in it: as an ancestor, or after the nightly
  rebase as an equivalent patch (`git cherry`) or a commit with the same
  subject (a conflict resolved during the rebase). Otherwise the run fails
  and lists the missing commits.

If commits were removed from `erik/main` on purpose, run the workflow by hand
on `erik/main` with `accept_dropped_commits`.

## Testing

Never run the workflow on a branch, and never build APKs or run emulators on
the PC (Erik, 2026-10-21: heavy work goes to the homelab). The end-to-end
test is one script for the homelab worker:

```sh
heavy -e PHASE=build --shell .#android -- scripts/erik-updates-e2e.sh   # no emulator needed
heavy emulator start                                                     # once it is free
heavy --big -e PHASE=device --shell .#android -- scripts/erik-updates-e2e.sh   # big: no build may share the node
heavy pull .erik-updates-e2e
heavy emulator stop
```

It builds APK 1000 and 1001 (a native change) with a throwaway signing key,
serves a local channel to the emulator (10.0.2.2), and checks: the APK's
runtime matches the resolved one; a JS update published while the app is open
downloads without a tap and applies when the app leaves the screen; APK 1001
downloads while the app is open, waits, and installs silently about 5 s after
Home (a WorkManager job: Android freezes a backgrounded app, so JS timers
cannot do it). `.erik-updates-e2e/summary.txt` says PASS or where it failed,
with logs and light/dark screenshots next to it. On a phone the one extra
step is the one-time "Install unknown apps" tap, which the script grants with
`appops`.
