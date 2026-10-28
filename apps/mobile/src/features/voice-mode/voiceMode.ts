import {
  DEFAULT_SPEAK_MODE,
  PERSONAL_AGENT_THREAD_ID,
  SpeakMode,
  type SpeakMode as SpeakModeValue,
} from "@t3tools/contracts";
import type { VoiceInputController } from "@t3tools/client-runtime/voice-input";
import { VoiceSession } from "@t3tools/client-runtime/voice-session";
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from "expo-audio";
import { fetch } from "expo/fetch";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { voiceCall } from "../../native/voiceCall";
import { voiceModeOpen } from "./voiceModeOpen";
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
 *
 * Whether the microphone opens after a message is Erik's voice mode, one
 * setting shared with the PC (`/api/speak-mode`): "Conversation" opens it,
 * "Voice out only" (the default) reads and waits, "Silent" says nothing. The
 * card has the toggle; each poll brings back the value, so a flip on the PC
 * shows here too.
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

function heard() {
  const preview = getDictationPreview();
  return Boolean(preview?.draft.trim() || preview?.final.trim());
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
  heard,
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
  /** Erik's voice mode, as the environment last said. */
  readonly speakMode: SpeakModeValue;
};

let state: VoiceModeState = {
  on: false,
  threadId: null,
  error: null,
  speakMode: DEFAULT_SPEAK_MODE,
};
const listeners = new Set<() => void>();

function set(patch: Partial<VoiceModeState>) {
  state = { ...state, ...patch };
  voiceModeOpen.set(state.on);
  for (const listener of listeners) listener();
}

const deviceId = `phone-${Math.random().toString(36).slice(2, 10)}`;
let polling = 0;

type Utterance = {
  readonly id: string;
  readonly text: string;
  readonly source?: string;
  readonly listen?: boolean;
};

const isSpeakMode = Schema.is(SpeakMode);

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
    const body = (await response.json()) as { utterances?: Utterance[]; speakMode?: unknown };
    if (isSpeakMode(body.speakMode) && body.speakMode !== state.speakMode) {
      set({ speakMode: body.speakMode });
    }
    return body.utterances ?? [];
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
      voiceSession.say({
        key: utterance.id,
        text: utterance.text,
        mode: "full",
        listen: utterance.listen !== false,
      });
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
  // Presence and Erik's voice mode right away, not after the first long poll.
  void beat(0).catch(() => undefined);
  void poll(++polling);
}

function stop() {
  if (!state.on) return;
  set({ on: false });
  polling++;
  // Talking when it was stopped: what was said is sent rather than lost (a
  // turn with nothing in it is dropped); the call stays up until the upload is done.
  const listening = voiceSession.getSnapshot().phase === "listening";
  const recording = listening && heard();
  if (listening && !recording) controller?.cancelAndDelete();
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
  // Silent: text only. Otherwise it is read, and the microphone opens after it
  // only in the Conversation mode.
  if (state.speakMode === "silent") return;
  voiceSession.say({
    key: reply.id,
    text: reply.text,
    mode: "summary",
    listen: state.speakMode === "conversation",
  });
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

/** Flips Erik's voice mode for the PC and the phone alike; shown at once, put back if it fails. */
async function setSpeakMode(speakMode: SpeakModeValue) {
  const before = state.speakMode;
  if (speakMode === before) return;
  set({ speakMode, error: null });
  const connection = readAloudConnection();
  const authorization = connection?.httpAuthorization ?? null;
  try {
    if (!connection || authorization?._tag === "Dpop") throw new Error("Not connected.");
    const response = await fetch(new URL("/api/speak-mode", connection.httpBaseUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: `Bearer ${authorization.token}` } : {}),
      },
      body: JSON.stringify({ mode: speakMode }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    // Unless another flip landed meanwhile.
    if (state.speakMode === speakMode) {
      set({
        speakMode: before,
        error: `Could not change the voice mode: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

export const voiceMode = {
  setSpeakMode: (mode: SpeakModeValue) => void setSpeakMode(mode),
  /** Voice mode is on: a message sent now is tagged "voice mode" for the agent. */
  isOpen: () => state.on,
  start: (threadId: string) => void start(threadId),
  stop,
  /** The card's big button: talk, send, or talk over what is being said. */
  press: () => voiceSession.endTurn(),
  /** Throws the turn away; nothing is sent. */
  discard: () => voiceSession.discardTurn(),
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
