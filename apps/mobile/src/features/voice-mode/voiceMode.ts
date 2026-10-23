import { PERSONAL_AGENT_THREAD_ID } from "@t3tools/contracts";
import type { VoiceInputController } from "@t3tools/client-runtime/voice-input";
import { VoiceSession } from "@t3tools/client-runtime/voice-session";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { fetch } from "expo/fetch";
import { useSyncExternalStore } from "react";

import { voiceCall } from "../../native/voiceCall";
import { reportVoiceModeSpan } from "../threads/activityLog";
import {
  playVoiceCue,
  readAloudConnection,
  readAloudPlayer,
  releaseReadAloudAudio,
} from "../threads/readAloudPlayback";
import { getDictationPreview } from "../voice-input/dictationPreview";

/**
 * Voice mode on the phone means "you may speak to me now". It is a small card
 * over the chat (the chat stays readable, scrollable and tappable), on until
 * Erik stops it. While it is on:
 *
 * - The personal agent's spoken messages (its `speak` tool) come to the phone
 *   instead of the PC's speakers: the phone tells the environment it is here
 *   (`/api/voice-presence`, a long poll), the PC's speak daemon checks that
 *   and hands each message over. On any other thread, which has no speak
 *   tool, each finished reply is what the agent has to say.
 * - After a message is read the microphone opens for the answer; silence
 *   drops it again. Erik can talk any time: the card's button, volume down,
 *   an earbud tap. What he says is sent to the thread like a dictated message.
 * - It runs as a "call" (`native/voiceCall.ts`), so it goes on with the screen
 *   off; volume up reads the last message again.
 *
 * Outside voice mode the phone never speaks unprompted: no presence, so the
 * daemon never routes anything here.
 */
type Composer = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void> | void;
};

const composers = new Map<string, Composer>();
const composer = (): Composer | null =>
  state.threadId ? (composers.get(state.threadId) ?? null) : null;
let controller: VoiceInputController | null = null;

/** Each open thread's composer, which dictation writes into and sends from. */
export function registerVoiceModeComposer(threadId: string, next: Composer): () => void {
  composers.set(threadId, next);
  return () => {
    if (composers.get(threadId) === next) composers.delete(threadId);
  };
}

export function registerVoiceModeController(next: VoiceInputController): void {
  controller = next;
}

// The words each spoken message was made from, so the chat can highlight the
// line being said (`SpokenMessage`).
const spokenSources = new Map<string, string>();

export function spokenSourceOf(key: string): string | undefined {
  return spokenSources.get(key);
}

const done: { id: string; status: "played" | "skipped" }[] = [];

export const voiceSession = new VoiceSession({
  player: readAloudPlayer,
  cue: playVoiceCue,
  onSpan: (span) => reportVoiceModeSpan({ ...span, threadId: state.threadId }),
  listen: async () => {
    const target = composer();
    if (!target) throw new Error("Open the thread to talk to it.");
    await target.start();
    const voice = controller?.currentState;
    if (voice && voice.phase !== "recording") {
      throw new Error(voice.error ?? "Dictation did not start.");
    }
  },
  send: () => composer()?.stop(),
  // Nothing was said: nothing to keep (cancel() would keep it as "saved, not sent").
  discard: () => controller?.cancelAndDelete(),
  heard: () => {
    const preview = getDictationPreview();
    return Boolean(preview?.draft.trim() || preview?.final.trim());
  },
  onDone: (key, status) => {
    if (spokenSources.has(key)) {
      done.push({ id: key, status });
      void beat(0);
    }
  },
});

type VoiceModeState = {
  readonly on: boolean;
  readonly threadId: string | null;
  readonly error: string | null;
};

let state: VoiceModeState = { on: false, threadId: null, error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<VoiceModeState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

const deviceId = `phone-${Math.random().toString(36).slice(2, 10)}`;
let polling = 0;

type Utterance = { readonly id: string; readonly text: string; readonly source?: string };

async function beat(waitMs: number): Promise<ReadonlyArray<Utterance>> {
  const connection = readAloudConnection();
  const authorization = connection?.httpAuthorization ?? null;
  if (!connection || authorization?._tag === "Dpop" || !state.threadId) return [];
  const reports = done.splice(0);
  try {
    const response = await fetch(
      new URL("/api/voice-presence", connection.httpBaseUrl).toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: `Bearer ${authorization.token}` } : {}),
        },
        body: JSON.stringify({
          deviceId,
          threadId: state.threadId,
          on: state.on,
          done: reports,
          waitMs,
        }),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()) as { utterances?: Utterance[] }).utterances ?? [];
  } catch (error) {
    done.unshift(...reports);
    throw error;
  }
}

/** While voice mode is on: wait for what the agent has to say, one long poll after another. */
async function poll(run: number) {
  while (run === polling && state.on) {
    const started = Date.now();
    let utterances: ReadonlyArray<Utterance> = [];
    try {
      utterances = await beat(20_000);
    } catch {
      // Offline for a moment: the daemon sees the phone gone meanwhile.
    }
    if (run !== polling) return;
    for (const utterance of utterances) {
      speaksHere = true;
      spokenSources.set(utterance.id, utterance.source ?? utterance.text);
      voiceSession.say({ key: utterance.id, text: utterance.text, mode: "full" });
    }
    // A poll that came back empty at once (no connection yet, a failure)
    // waits before the next: otherwise the loop spins and freezes the app.
    if (utterances.length === 0 && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function start(threadId: string) {
  if (state.on) return;
  set({ on: true, threadId, error: null });
  speaksHere = false;
  // The call's service may only use the microphone once it is granted.
  const permission = await getRecordingPermissionsAsync();
  if (!permission.granted && !(await requestRecordingPermissionsAsync()).granted) {
    set({ on: false, error: "Voice mode needs the microphone." });
    return;
  }
  if (!state.on) return;
  try {
    voiceCall.start();
  } catch (error) {
    set({ on: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  voiceSession.start();
  void poll(++polling);
}

function stop() {
  if (!state.on) return;
  set({ on: false });
  polling++;
  // Talking when it was stopped: what was said is sent rather than lost; the
  // call stays up until the upload is done.
  const recording = voiceSession.getSnapshot().phase === "listening";
  voiceSession.stop();
  void beat(0).catch(() => undefined);
  void Promise.resolve(recording ? composer()?.stop() : undefined)
    .catch(() => undefined)
    .then(() => {
      if (!state.on) voiceCall.stop();
    });
}

/**
 * On a thread without a speak tool, a reply that finished after voice mode
 * came on is what the agent has to say (read as a short spoken summary). Once
 * the thread has spoken through the speak tool, that is what it says, and its
 * replies are not read as well.
 */
let replySeen: string | null = null;
let speaksHere = false;
export function voiceModeThreadChanged(
  threadId: string,
  reply: { readonly id: string; readonly text: string } | null,
  working: boolean,
) {
  if (
    !state.on ||
    state.threadId !== threadId ||
    threadId === PERSONAL_AGENT_THREAD_ID ||
    speaksHere
  ) {
    replySeen = reply?.id ?? null;
    return;
  }
  if (working || !reply || reply.id === replySeen) return;
  replySeen = reply.id;
  voiceSession.say({ key: reply.id, text: reply.text, mode: "summary" });
}

// The call's buttons, for the whole of voice mode (the call's volume stays
// where it was): up reads the last message again, down or an earbud tap
// talks, sends, or skips what is being said.
voiceSession.subscribe(() => {
  const phase = voiceSession.getSnapshot().phase;
  if (phase === "listening") releaseReadAloudAudio();
  voiceCall.setListening(phase !== "off");
});

voiceCall.onEvent((event) => {
  if (!state.on) return;
  if (event.type === "hangUp") stop();
  else if (event.type === "volume" && event.direction === "up") voiceSession.replay();
  else if (event.type === "volume" || event.type === "button") voiceSession.endTurn();
});

export const voiceMode = {
  /** Voice mode is on: a message sent now is tagged "voice mode" for the agent. */
  isOpen: () => state.on,
  start: (threadId: string) => void start(threadId),
  stop,
  /** The card's big button: talk, send, or talk over what is being said. */
  press: () => voiceSession.endTurn(),
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

export function useVoiceSession() {
  return useSyncExternalStore(voiceSession.subscribe, voiceSession.getSnapshot);
}
