// @effect-diagnostics globalTimers:off -- Plain promises shared with React Native, like readAloud.ts; the silence timer is injectable for tests.
import type { ReadAloudMode } from "@t3tools/contracts";

import type { ReadAloudPlayer } from "./readAloud.ts";
import { VOICE_LOOP_CUE, VOICE_LOOP_CUE_KEY } from "./voiceLoop.ts";

/**
 * Voice mode as "you may speak to me now" (Erik, 2026-10-23: the turn-taking
 * loop was too strict). While it is on, the agent speaks when it has
 * something worth saying; each message is read, then the microphone opens
 * for the answer. Erik can also talk any time. Sending never makes the agent
 * answer out loud right away: the next message comes when it comes.
 *
 * Messages that arrive while Erik talks wait until he has sent. A turn the
 * agent opened that stays silent is dropped, so the microphone is not left
 * open on an empty room.
 */
export type VoiceSessionPhase = "off" | "idle" | "speaking" | "cue" | "listening" | "sending";

export type VoiceUtterance = {
  readonly key: string;
  readonly text: string;
  /** "full" reads the words as they are (the speak tool already wrote them for the ear). */
  readonly mode?: ReadAloudMode;
};

export type VoiceSessionSnapshot = {
  readonly phase: VoiceSessionPhase;
  readonly error: string | null;
  /** The message being read, or the last one read. */
  readonly utterance: VoiceUtterance | null;
  /** Messages waiting for Erik to finish talking. */
  readonly waiting: number;
};

export type VoiceSessionDependencies = {
  readonly player: ReadAloudPlayer;
  /** Starts dictation into the thread's composer. */
  readonly listen: () => Promise<void> | void;
  /** Ends dictation and sends what was said. */
  readonly send: () => Promise<void> | void;
  /**
   * Plays the "your turn" cue straight on the audio (a short chime), not through
   * the read-aloud player. Without it the cue is spoken.
   */
  readonly cue?: () => Promise<void> | void;
  /** Ends dictation and throws the recording away. */
  readonly discard: () => void;
  /** Something was said in the current recording. */
  readonly heard: () => boolean;
  /** A message was heard, or will not be (skipped, or voice mode ended first). */
  readonly onDone?: (key: string, status: "played" | "skipped") => void;
  readonly onSpan?: (span: { startedAt: number; endedAt: number }) => void;
  readonly now?: () => number;
  readonly setTimeout?: (run: () => void, ms: number) => () => void;
  /** A recording the agent opened is dropped after this long without a word. */
  readonly silenceMs?: number;
};

export const VOICE_SESSION_SILENCE_MS = 30_000;

const isSpeaking = (phase: string) =>
  phase === "loading" || phase === "playing" || phase === "paused";

export class VoiceSession {
  #deps: VoiceSessionDependencies;
  #state: VoiceSessionSnapshot = { phase: "off", error: null, utterance: null, waiting: 0 };
  #listeners = new Set<() => void>();
  #queue: VoiceUtterance[] = [];
  #seen = new Set<string>();
  #run = 0;
  #startedAt = 0;
  #cancelSilence: (() => void) | null = null;

  constructor(deps: VoiceSessionDependencies) {
    this.#deps = deps;
  }

  getSnapshot = (): VoiceSessionSnapshot => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get active(): boolean {
    return this.#state.phase !== "off";
  }

  #set(patch: Partial<VoiceSessionSnapshot>) {
    this.#state = { ...this.#state, ...patch, waiting: this.#queue.length };
    for (const listener of this.#listeners) listener();
  }

  #now() {
    return (this.#deps.now ?? Date.now)();
  }

  start() {
    if (this.active) return;
    this.#run++;
    this.#startedAt = this.#now();
    this.#set({ phase: "idle", error: null });
    this.#next();
  }

  /** Ends voice mode; a recording in progress stays with the composer. */
  stop() {
    if (!this.active) return;
    this.#run++;
    this.#clearSilence();
    const { phase, utterance } = this.#state;
    if (phase === "speaking" || phase === "cue") this.#deps.player.stop();
    if (phase === "speaking" && utterance) this.#deps.onDone?.(utterance.key, "skipped");
    for (const waiting of this.#queue.splice(0)) this.#deps.onDone?.(waiting.key, "skipped");
    this.#set({ phase: "off" });
    this.#deps.onSpan?.({ startedAt: this.#startedAt, endedAt: this.#now() });
  }

  /** The agent has something to say. Said now, or once Erik has finished talking. */
  say(utterance: VoiceUtterance) {
    if (!this.active || this.#seen.has(utterance.key)) return;
    this.#seen.add(utterance.key);
    this.#queue.push(utterance);
    this.#set({});
    if (this.#state.phase === "idle") this.#next();
  }

  /** Erik wants to talk: now, even over the agent (what it was saying is skipped). */
  talk() {
    const { phase, utterance } = this.#state;
    if (phase === "idle") void this.#listen(++this.#run, false);
    else if (phase === "speaking") {
      const run = ++this.#run;
      this.#deps.player.stop();
      if (utterance) this.#deps.onDone?.(utterance.key, "played");
      void this.#listen(run, false);
    }
  }

  /**
   * One control for everything (the big button, a volume key, an earbud tap):
   * while listening it sends; otherwise it starts Erik's turn.
   */
  endTurn() {
    if (this.#state.phase === "listening") void this.#send(this.#run);
    else this.talk();
  }

  /** Reads the last message again from the top; then the microphone opens again. */
  replay() {
    const { phase, utterance } = this.#state;
    if (!utterance) return;
    // While Erik talks it plays over the recording, which goes on (the call's
    // echo canceller keeps it out); he wants to hear it again right where he answers.
    if (phase === "cue" || phase === "listening") {
      this.#deps.player.start(utterance.key, utterance.text, utterance.mode ?? "full");
      return;
    }
    if (phase !== "idle" && phase !== "speaking") return;
    if (phase === "speaking") this.#deps.player.stop();
    void this.#speak(++this.#run, utterance, false);
  }

  /** Erik throws his turn away: nothing is sent, the agent may speak again. */
  discardTurn() {
    const phase = this.#state.phase;
    if (phase !== "listening" && phase !== "cue") return;
    this.#run++;
    this.#clearSilence();
    this.#stopCue();
    this.#deps.discard();
    this.#set({ phase: "idle" });
    this.#next();
  }

  /** The dictation was sent some other way (the composer's own button). */
  sent() {
    const phase = this.#state.phase;
    if (phase !== "listening" && phase !== "sending") return;
    this.#run++;
    this.#stopCue();
    this.#clearSilence();
    this.#set({ phase: "idle" });
    this.#next();
  }

  #next() {
    const utterance = this.#queue.shift();
    if (utterance) void this.#speak(++this.#run, utterance, true);
    else this.#set({});
  }

  async #speak(run: number, utterance: VoiceUtterance, report: boolean) {
    this.#set({ phase: "speaking", utterance });
    this.#deps.player.start(utterance.key, utterance.text, utterance.mode ?? "full");
    await this.#played(utterance.key);
    if (run !== this.#run) return;
    if (report) this.#deps.onDone?.(utterance.key, "played");
    // Several at once: all of them first, then one answer.
    const next = this.#queue.shift();
    if (next) return void this.#speak(++this.#run, next, true);
    void this.#listen(run, true);
  }

  /**
   * The microphone opens first and the cue is said over it: Erik often starts
   * talking the moment he hears it, and a recording that only began after the
   * cue lost his first words (2026-10-23).
   */
  async #listen(run: number, invited: boolean) {
    this.#set({ phase: "cue" });
    try {
      await this.#deps.listen();
    } catch (error) {
      if (run === this.#run) this.#fail(error);
      return;
    }
    if (run !== this.#run || this.#state.phase !== "cue") return;
    this.#set({ phase: "listening" });
    if (this.#deps.cue)
      void Promise.resolve()
        .then(() => this.#deps.cue?.())
        .catch(() => undefined);
    else this.#deps.player.start(VOICE_LOOP_CUE_KEY, VOICE_LOOP_CUE, "full");
    if (invited) this.#watchSilence(run);
  }

  #stopCue() {
    if (this.#deps.player.getSnapshot().key === VOICE_LOOP_CUE_KEY) this.#deps.player.stop();
  }

  #watchSilence(run: number) {
    this.#clearSilence();
    const schedule =
      this.#deps.setTimeout ??
      ((fn: () => void, ms: number) => {
        const timer = globalThis.setTimeout(fn, ms);
        return () => globalThis.clearTimeout(timer);
      });
    this.#cancelSilence = schedule(() => {
      this.#cancelSilence = null;
      if (run !== this.#run || this.#state.phase !== "listening" || this.#deps.heard()) return;
      this.#run++;
      this.#stopCue();
      this.#deps.discard();
      this.#set({ phase: "idle" });
      this.#next();
    }, this.#deps.silenceMs ?? VOICE_SESSION_SILENCE_MS);
  }

  #clearSilence() {
    this.#cancelSilence?.();
    this.#cancelSilence = null;
  }

  async #send(run: number) {
    this.#clearSilence();
    this.#stopCue();
    this.#set({ phase: "sending" });
    try {
      await this.#deps.send();
    } catch (error) {
      if (run === this.#run) this.#fail(error);
      return;
    }
    if (run !== this.#run || this.#state.phase !== "sending") return;
    this.#set({ phase: "idle" });
    this.#next();
  }

  /** A failed turn does not end voice mode: the agent may still speak, Erik may try again. */
  #fail(error: unknown) {
    this.#run++;
    this.#clearSilence();
    this.#set({ phase: "idle", error: error instanceof Error ? error.message : String(error) });
  }

  #played(key: string): Promise<void> {
    const player = this.#deps.player;
    return new Promise((resolve) => {
      const check = () => {
        const state = player.getSnapshot();
        if (state.key === key && isSpeaking(state.phase)) return;
        unsubscribe();
        resolve();
      };
      const unsubscribe = player.subscribe(check);
      check();
    });
  }
}
