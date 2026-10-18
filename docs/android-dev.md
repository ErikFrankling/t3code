# Android development (fork-only, NixOS)

Live-reload development of `apps/mobile` on an emulator or a phone, from a Nix
dev shell. Fork-only files: `flake.nix`, `flake.lock`, `scripts/android-dev/`,
this doc. The release APK is still built by `.github/workflows/erik-android.yml`.

## The shell

```sh
nix develop .#android        # from the repo root
CI=true pnpm install --frozen-lockfile   # once per checkout
```

It provides Node 24, pnpm 11, JDK 17 and an Android SDK from nixpkgs
`androidenv` (platforms 36 + 37.0, build-tools 37.0.0, NDK 27.1.12297006,
CMake 3.22.1, emulator, `android-36` Google APIs x86_64 image), sets
`ANDROID_HOME`/`ANDROID_SDK_ROOT`/`JAVA_HOME`, points Gradle at the SDK's aapt2
(`GRADLE_OPTS=-Dorg.gradle.project.android.aapt2FromMavenOverride=...`, the
Maven aapt2 does not run on NixOS) and puts `scripts/android-dev` on `PATH`.
The SDK is read-only, so if a new React Native asks for another SDK/NDK
version, add it in `flake.nix` (versions: `node_modules/react-native/gradle/libs.versions.toml`).

## Desktop (emulator in a window)

```sh
nix develop .#android
android-emulator             # creates AVD t3code-api36 once, opens a window (XWayland, -gpu host)
android-dev                  # first run builds+installs the dev client (7 min on the PC), then Metro
```

Edit JS/TS under `apps/mobile` or `packages/*`; the app reloads on save.
Press `r` in Metro to reload, `m` for the dev menu. In the app, add the
environment `http://10.0.2.2:3773` (the emulator's name for the PC; any
pairing code works in no-auth mode).

`android-emulator stop` shuts the emulator down. The emulator log
(`~/.local/state/t3code-android/emulator.log`) may say "Your GPU cannot be used
for hardware rendering" with `-gpu host` on the RX 7900 XT; it still rendered
in testing. If the window is black, try
`T3_EMULATOR_GPU=swiftshader_indirect android-emulator`.

## Agents (headless)

Write output to files; do not pipe `nix develop -c ...` into `tail`/`grep`:
Determinate Nix's crash reporter (`crashpad_handler`) inherits stdout and can
keep the pipe open after the command finishes.

```sh
nix develop .#android -c android-emulator --headless > emulator-start.log 2>&1   # ~20 s cold boot
nohup nix develop .#android -c android-dev > android-dev.log 2>&1 &              # build once, Metro, opens the app
nix develop .#android -c android-screenshot shot.png
nix develop .#android -c adb shell input tap 540 1200     # drive it (1080x2400 screen)
nix develop .#android -c adb shell input text 'hello'
```

`android-dev` waits for Metro and opens the app via
`t3code-dev://expo-development-client/?url=http://localhost:8081` (with
`adb reverse`); rerun just that with `android-dev open`. The first launch
shows the dev-menu intro sheet: tap Continue (540 2167). The first build took
7 min on the PC (x86_64 only; Gradle/Maven caches in `~/.gradle`).

When done: `android-emulator stop` and kill Metro (`expo start`). The build
step stops the Gradle daemons itself (set `T3_KEEP_GRADLE_DAEMON=1` to keep
them). Memory: emulator ~3 GB, Gradle build peaks at ~8 GB with workers capped
at 4 (`T3_GRADLE_WORKERS`). Metro rewrites `apps/mobile/uniwind-types.d.ts`
(a header comment); do not commit that.

## Erik's phone

The dev variant (`com.t3tools.t3code.dev`, "T3 Code Dev") installs next to the
preview build.

- USB (or `adb pair`/`adb connect` over Wi-Fi): with only the phone attached,
  `android-dev build` builds for its ABI (arm64-v8a) and installs it. Then
  `android-dev` as above; over USB `adb reverse` makes `localhost:8081` work.
- Over home Wi-Fi/Tailscale, no cable: `android-dev --phone`. Metro then
  advertises `https://pc-8081.erikfrankling.duckdns.org` (the PC's
  dev-preview proxy, no firewall change). Open T3 Code Dev and enter that URL,
  or `android-dev open --phone` while adb-connected. Hot reload goes through
  the same proxy (WebSocket); tested from the emulator via that URL.

## Rebuild the native app when

Native dependencies, `app.config.ts`, or plugins changed:
`android-dev build --clean` (runs `expo prebuild --clean`). JS-only changes
never need a rebuild.
