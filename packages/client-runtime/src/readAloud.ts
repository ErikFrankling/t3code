// @effect-diagnostics globalTimers:off -- Plain promise polling and playback, shared with React Native; no Effect runtime here.
import type { ReadAloudMode, ReadAloudRequest, ReadAloudState } from "@t3tools/contracts";

/**
 * Client side of read-aloud (`/api/read-aloud`, see the server's readAloud.ts):
 * starts a job, polls for sentences, and plays each clip as soon as it lands,
 * so the first sentence speaks while the summary is still being written.
 * Platforms only supply HTTP and audio playback.
 */
export interface ReadAloudAudio {
  /** Plays one base64 MP3 clip; resolves when it ends, rejects if stopped. */
  play(base64Mp3: string, rate: number): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
}

export type ReadAloudPhase = "idle" | "loading" | "playing" | "paused" | "done" | "error";

export type ReadAloudSnapshot = {
  readonly phase: ReadAloudPhase;
  /** Identifies the message being read, e.g. its message id. */
  readonly key: string | null;
  readonly mode: ReadAloudMode;
  readonly sentences: readonly string[];
  /** Index of the sentence being spoken (or next to speak). */
  readonly current: number;
  readonly voice: string;
  readonly error: string | null;
  /** Playback speed multiplier sent to the server and kept between messages. */
  readonly speed: number;
};

export type ReadAloudDependencies = {
  readonly request: (body: ReadAloudRequest) => Promise<ReadAloudState>;
  readonly audio: ReadAloudAudio;
  readonly pollMs?: number;
  readonly speed?: number;
  readonly onSpeedChange?: (speed: number) => void;
};

export const READ_ALOUD_SPEEDS = [0.9, 1, 1.15, 1.3, 1.5] as const;

const idle = (speed: number): ReadAloudSnapshot => ({
  phase: "idle",
  key: null,
  mode: "summary",
  sentences: [],
  current: 0,
  voice: "",
  error: null,
  speed,
});

export class ReadAloudPlayer {
  #deps: ReadAloudDependencies;
  #state: ReadAloudSnapshot;
  #listeners = new Set<() => void>();
  #clips: (string | undefined)[] = [];
  #session = 0;
  #complete = false;
  #wake: (() => void) | null = null;
  #jobId: string | null = null;
  // The server synthesizes at the speed the job started with; a later change
  // plays the remaining clips faster or slower instead of re-synthesizing.
  #jobSpeed = 1;
  #text = "";

  constructor(deps: ReadAloudDependencies) {
    this.#deps = deps;
    this.#state = idle(deps.speed ?? 1);
  }

  getSnapshot = (): ReadAloudSnapshot => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<ReadAloudSnapshot>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Reads a message from the top; replaces whatever was playing. */
  start(key: string, text: string, mode: ReadAloudMode = "summary") {
    this.#text = text;
    this.#deps.audio.stop();
    const session = ++this.#session;
    this.#clips = [];
    this.#complete = false;
    this.#set({ ...idle(this.#state.speed), phase: "loading", key, mode });
    void this.#fetch(session, text, mode);
    void this.#playLoop(session);
  }

  /** Reads the same message again in the other mode (summary or the full text). */
  switchMode(mode: ReadAloudMode) {
    if (this.#state.key !== null) this.start(this.#state.key, this.#text, mode);
  }

  stop() {
    this.#session++;
    this.#wake?.();
    this.#deps.audio.stop();
    this.#set(idle(this.#state.speed));
  }

  togglePause() {
    if (this.#state.phase === "playing") {
      this.#deps.audio.pause();
      this.#set({ phase: "paused" });
    } else if (this.#state.phase === "paused") {
      this.#deps.audio.resume();
      this.#set({ phase: "playing" });
      this.#wake?.();
    } else if (this.#state.phase === "done") {
      this.seek(0);
    }
  }

  /** Jumps to a sentence; playback continues from there. */
  seek(index: number) {
    if (this.#state.key === null) return;
    const target = Math.max(0, Math.min(index, this.#state.sentences.length - 1));
    const session = ++this.#session;
    this.#deps.audio.stop();
    this.#set({ current: target, phase: this.#clips[target] ? "playing" : "loading" });
    // Fetching continues under the old session only if it was still running.
    if (!this.#complete) void this.#fetchContinue(session);
    void this.#playLoop(session);
  }

  /** Changes the pace: sent to the server with the next message, applied to this one by playback rate. */
  setSpeed(speed: number) {
    this.#set({ speed });
    this.#deps.onSpeedChange?.(speed);
  }

  async #fetch(session: number, text: string, mode: ReadAloudMode) {
    try {
      this.#jobSpeed = this.#state.speed;
      const state = await this.#deps.request({ text, mode, speed: this.#jobSpeed });
      if (session !== this.#session) return;
      this.#jobId = state.id;
      this.#absorb(state);
      await this.#poll(session);
    } catch (error) {
      if (session === this.#session) this.#fail(error);
    }
  }

  async #fetchContinue(session: number) {
    try {
      await this.#poll(session);
    } catch (error) {
      if (session === this.#session) this.#fail(error);
    }
  }

  async #poll(session: number) {
    while (session === this.#session && !this.#complete && this.#jobId) {
      await new Promise((resolve) => setTimeout(resolve, this.#deps.pollMs ?? 400));
      if (session !== this.#session) return;
      const from = this.#clips.findIndex((clip) => clip === undefined);
      const state = await this.#deps.request({
        id: this.#jobId,
        from: from === -1 ? this.#clips.length : from,
      });
      if (session !== this.#session) return;
      this.#absorb(state);
    }
  }

  #absorb(state: ReadAloudState) {
    state.sentences.forEach((sentence, index) => {
      if (sentence.audio) this.#clips[index] = sentence.audio;
    });
    this.#complete = state.status !== "working";
    this.#set({
      sentences: state.sentences.map((sentence) => sentence.text),
      voice: state.voice,
      ...(state.status === "error" ? { phase: "error", error: state.error } : {}),
    });
    this.#wake?.();
  }

  #fail(error: unknown) {
    this.#complete = true;
    this.#set({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    this.#wake?.();
  }

  async #playLoop(session: number) {
    while (session === this.#session) {
      const index = this.#state.current;
      const clip = this.#clips[index];
      if (clip === undefined) {
        if (this.#complete && index >= this.#state.sentences.length) {
          this.#set({ phase: this.#state.phase === "error" ? "error" : "done" });
          return;
        }
        if (this.#state.phase === "error") return;
        await new Promise<void>((resolve) => (this.#wake = resolve));
        continue;
      }
      if (this.#state.phase === "paused") {
        await new Promise<void>((resolve) => (this.#wake = resolve));
        continue;
      }
      this.#set({ phase: "playing" });
      try {
        await this.#deps.audio.play(clip, this.#state.speed / this.#jobSpeed);
      } catch {
        return;
      }
      if (session !== this.#session) return;
      this.#set({ current: index + 1 });
    }
  }
}
