import { VoiceLoop } from "@t3tools/client-runtime/voice-loop";
import type { VoiceInputController } from "@t3tools/client-runtime/voice-input";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { useSyncExternalStore } from "react";

import { voiceCall } from "../../native/voiceCall";
import { readAloudPlayer, releaseReadAloudAudio } from "../threads/ReadAloudButton";

/**
 * Voice mode on the phone: the full-screen view and its loop. With the loop on,
 * a "call" runs (see `native/voiceCall.ts`), so it goes on with the screen off:
 * a volume key or an earbud tap ends your turn and sends it, or skips the
 * reading, and the notification's Hang up ends the call.
 */
type Composer = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void> | void;
};

let composer: Composer | null = null;
let controller: VoiceInputController | null = null;

/** The open thread's composer, which dictation writes into and sends from. */
export function registerVoiceModeComposer(next: Composer): () => void {
  composer = next;
  return () => {
    if (composer === next) composer = null;
  };
}

export function registerVoiceModeController(next: VoiceInputController): void {
  controller = next;
}

export const voiceLoop = new VoiceLoop({
  player: readAloudPlayer,
  listen: async () => {
    if (!composer) throw new Error("Open a thread to talk to it.");
    await composer.start();
    const voice = controller?.currentState;
    if (voice && voice.phase !== "recording") {
      throw new Error(voice.error ?? "Dictation did not start.");
    }
  },
  send: () => composer?.stop(),
});

type VoiceModeState = {
  readonly open: boolean;
  readonly loop: boolean;
  readonly error: string | null;
};

let state: VoiceModeState = { open: false, loop: false, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<VoiceModeState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function setLoop(on: boolean) {
  if (on === state.loop) return;
  set({ loop: on, error: null });
  if (on) {
    void (async () => {
      // The call's service may only use the microphone once it is granted.
      const permission = await getRecordingPermissionsAsync();
      if (!permission.granted && !(await requestRecordingPermissionsAsync()).granted) {
        set({ loop: false, error: "Voice mode needs the microphone." });
        return;
      }
      if (!state.loop) return;
      try {
        voiceCall.start();
      } catch (error) {
        set({ loop: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      voiceLoop.start();
    })();
  } else {
    voiceLoop.stop();
    // Hanging up mid-sentence sends what was said rather than losing it; the
    // call stays up until the upload is done.
    const recording = controller?.currentState.phase === "recording";
    void Promise.resolve(recording ? composer?.stop() : undefined)
      .catch(() => undefined)
      .then(() => {
        if (!state.loop) voiceCall.stop();
      });
  }
}

// Volume keys are the turn button while you talk or wait for the reply; while
// it is read they set the volume.
let loopPhase = voiceLoop.getSnapshot().phase;
voiceLoop.subscribe(() => {
  const phase = voiceLoop.getSnapshot().phase;
  if (phase === "listening") releaseReadAloudAudio();
  voiceCall.setListening(phase === "listening" || phase === "waiting");
  // The loop stops itself when dictation fails; the call ends with it.
  if (phase === "off" && loopPhase !== "off" && state.loop) setLoop(false);
  loopPhase = phase;
});

voiceCall.onEvent((event) => {
  if (event === "hangUp") setLoop(false);
  else voiceLoop.endTurn();
});

export const voiceMode = {
  open: () => set({ open: true }),
  close: () => {
    setLoop(false);
    set({ open: false });
  },
  setLoop,
  /** Without the loop: dictate, and send. */
  talk: () => void composer?.start(),
  send: () => void composer?.stop(),
};

export function useVoiceMode(): VoiceModeState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

export function useVoiceLoop() {
  return useSyncExternalStore(voiceLoop.subscribe, voiceLoop.getSnapshot);
}
