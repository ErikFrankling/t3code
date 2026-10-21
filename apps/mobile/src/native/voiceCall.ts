import { requireOptionalNativeModule } from "expo";
import { AppRegistry, Platform } from "react-native";

/**
 * Voice mode's phone "call" (Android, `modules/t3-voice-call`): communication
 * mode, one route (a headset, else the speaker), one speaker and one open
 * microphone, set up once when voice mode starts and held until it ends. A
 * foreground service keeps them and the JS timers going with the screen off.
 * It reports the volume keys and the earbud button, and plays replies on the
 * call's route.
 */
export type VoiceCallEvent =
  | { readonly type: "volume"; readonly direction?: "up" | "down" }
  | { readonly type: "button"; readonly source?: string }
  | { readonly type: "hangUp" }
  | { readonly type: "progress"; readonly id: string; readonly fraction: number }
  | { readonly type: "ended"; readonly id: string }
  | { readonly type: "route"; readonly kind: string; readonly name: string }
  | { readonly type: "routeLost"; readonly name: string }
  | { readonly type: "interrupted" }
  | { readonly type: "resumed" };

type RecordingStatus = {
  readonly isRecording: boolean;
  readonly durationMillis: number;
  readonly metering: number;
  readonly bluetooth: boolean;
};

type VoiceCallModule = {
  start(): void;
  stop(): void;
  isActive(): boolean;
  setListening(listening: boolean): void;
  route(): { readonly kind: string; readonly name: string };
  /** The current or last call's audio mode and route changes (AudioLog.kt). */
  audioLog(): string;
  play(id: string, wav: string, speed: number, startFraction: number): Promise<void>;
  clearPlayback(): void;
  pausePlayback(): void;
  resumePlayback(): void;
  prepareRecording(): string;
  startRecording(preferBluetooth: boolean): Promise<void>;
  stopRecording(): Promise<void>;
  recordingStatus(): RecordingStatus;
  addListener(
    event: "onVoiceCallEvent",
    listener: (event: VoiceCallEvent) => void,
  ): {
    remove(): void;
  };
};

const native =
  Platform.OS === "android" ? requireOptionalNativeModule<VoiceCallModule>("T3VoiceCall") : null;

// The service starts this task so React Native keeps timers running in the
// background; it lasts until the call ends, when the service finishes it.
if (native) AppRegistry.registerHeadlessTask("T3VoiceCall", () => () => new Promise(() => {}));

// A call left over from a previous JS runtime (a reload or restart) has no loop to drive it.
if (native?.isActive()) native.stop();

const listeners = new Set<() => void>();
let active = false;

function setActive(next: boolean) {
  if (next === active) return;
  active = next;
  for (const listener of listeners) listener();
}

export const voiceCall = {
  available: native !== null,
  get active() {
    return active;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  start() {
    if (!native || active) return;
    native.start();
    setActive(true);
  },
  stop() {
    if (!native || !active) return;
    native.stop();
    setActive(false);
  },
  setListening(listening: boolean) {
    if (active) native?.setListening(listening);
  },
  onEvent(listener: (event: VoiceCallEvent) => void) {
    const subscription = native?.addListener("onVoiceCallEvent", listener);
    return () => subscription?.remove();
  },
  native,
};
