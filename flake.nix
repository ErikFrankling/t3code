{
  # Fork-only (ErikFrankling/t3code): a Nix dev shell for building and
  # hot-reloading the Android app in apps/mobile on NixOS. Usage and pitfalls:
  # docs/android-dev.md. Kept to new files so upstream rebases never conflict.
  description = "T3 Code Android dev shell (Expo dev client, emulator, Metro)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
          android_sdk.accept_license = true;
        };
      };

      # Versions the React Native 0.88 / Expo SDK 58 Gradle build asks for
      # (node_modules/react-native/gradle/libs.versions.toml). The Nix SDK is
      # read-only, so anything Gradle wants must be listed here.
      buildToolsVersion = "37.0.0";
      ndkVersion = "27.1.12297006";
      # 37.0 = compileSdk 37 (installed as platforms/android-37.0); 36 = targetSdk and the emulator system image.
      emulatorApi = "36";

      android = pkgs.androidenv.composeAndroidPackages {
        platformVersions = [
          emulatorApi
          "37.0"
        ];
        buildToolsVersions = [
          buildToolsVersion
          "36.0.0"
        ];
        includeNDK = true;
        ndkVersions = [ ndkVersion ];
        cmakeVersions = [ "3.22.1" ];
        includeEmulator = true;
        includeSystemImages = true;
        systemImageTypes = [ "google_apis" ];
        abiVersions = [ "x86_64" ];
      };
      sdkRoot = "${android.androidsdk}/libexec/android-sdk";

      androidShell = pkgs.mkShell {
        packages = [
          android.androidsdk
          pkgs.nodejs_24
          pkgs.pnpm_11
          pkgs.jdk17
          pkgs.jq
          pkgs.curl
        ];

        ANDROID_HOME = sdkRoot;
        ANDROID_SDK_ROOT = sdkRoot;
        ANDROID_NDK_HOME = "${sdkRoot}/ndk/${ndkVersion}";
        JAVA_HOME = pkgs.jdk17.home;
        T3_ANDROID_EMULATOR_API = emulatorApi;
        # Gradle's aapt2 from Maven is a generic Linux binary that cannot run on
        # NixOS; use the SDK's patched one instead.
        GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdkRoot}/build-tools/${buildToolsVersion}/aapt2";
        # The fork's JS must not be replaced by upstream's OTA updates.
        T3CODE_MOBILE_UPDATES_ENABLED = "0";
        EXPO_NO_TELEMETRY = "1";
        EXPO_NO_GIT_STATUS = "1";

        shellHook = ''
          export PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/scripts/android-dev:$PATH"
          echo "T3 Code Android shell: android-emulator, android-dev, android-screenshot (docs/android-dev.md)"
        '';
      };
    in
    {
      devShells.${system} = {
        android = androidShell;
        default = androidShell;
      };
    };
}
