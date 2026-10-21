import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { AppState, Platform } from "react-native";

import {
  flushPendingAppWrites,
  hasPendingAppUpdate,
  isAppUpdateCheckAvailable,
  runAppUpdateCheck,
} from "./app-updates";

/**
 * Erik's fork: every release reaches the phone without a tap
 * (docs/erik-updates.md). JavaScript changes come as signed OTA updates from
 * his own update server; native changes come as an APK that the app installs
 * itself (modules/t3-self-update). While the app is open it checks every
 * minute and applies what it found the next time it leaves the screen; while
 * it is closed, a WorkManager job checks for APKs every 15 minutes.
 */
interface SelfUpdateModule {
  readonly configure: (indexUrl: string) => void;
  readonly check: (installNow: boolean) => Promise<string>;
  readonly checkAfterBackgrounding: () => void;
}

export const ERIK_UPDATE_POLL_MS = 60 * 1000;

const selfUpdate =
  Platform.OS === "android" ? requireOptionalNativeModule<SelfUpdateModule>("T3SelfUpdate") : null;

function selfUpdateIndexUrl(): string | null {
  const url: unknown = Constants.expoConfig?.extra?.selfUpdateUrl;
  return typeof url === "string" && url.length > 0 ? url : null;
}

let started = false;

export function startErikAutoUpdates(): void {
  if (started) return;
  const indexUrl = selfUpdateIndexUrl();
  const native = indexUrl ? selfUpdate : null;
  const ota = isAppUpdateCheckAvailable();
  if (!native && !ota) return;
  started = true;
  native?.configure(indexUrl!);

  const tick = () => {
    if (ota && !hasPendingAppUpdate()) void runAppUpdateCheck();
    void native?.check(false).catch(() => undefined);
  };

  let timer: ReturnType<typeof setInterval> | undefined;
  const arm = () => {
    timer ??= setInterval(tick, ERIK_UPDATE_POLL_MS);
  };
  const disarm = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      tick();
      arm();
      return;
    }
    if (state !== "background") return;
    disarm();
    if (!native) return;
    // A downloaded APK installs once nothing is on screen. Installing
    // replaces the process, so save drafts and the outbox first. Android
    // freezes a backgrounded app within seconds and JS timers stop, so the
    // native side schedules the install itself; it still refuses while the
    // app is visible or runs a foreground service (voice mode).
    void flushPendingAppWrites()
      .catch(() => undefined)
      .then(() => native.checkAfterBackgrounding());
  });
  if (AppState.currentState === "active") arm();
  void native?.check(false).catch(() => undefined);
}
