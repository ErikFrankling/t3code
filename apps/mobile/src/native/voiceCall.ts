import { requireOptionalNativeModule } from "expo";
import { AppRegistry, Platform } from "react-native";

/**
 * Voice mode's phone "call" (Android, `modules/t3-voice-call`): a foreground
 * service that keeps the microphone, playback and the JS timers going with the
 * screen off, and reports the volume keys and the earbud button.
 */
export type VoiceCallEvent = "volume" | "button" | "hangUp";

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
  prepareRecording(): string;
  startRecording(preferBluetooth: boolean): Promise<void>;
  stopRecording(): Promise<void>;
  recordingStatus(): RecordingStatus;
  addListener(
    event: "onVoiceCallEvent",
    listener: (event: { type: VoiceCallEvent }) => void,
  ): { remove(): void };
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
    const subscription = native?.addListener("onVoiceCallEvent", (event) => listener(event.type));
    return () => subscription?.remove();
  },
  native,
};
