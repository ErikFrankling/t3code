// @effect-diagnostics globalTimers:off -- Plain promise polling and playback, shared with React Native; no Effect runtime here.
import type { ReadAloudMode, ReadAloudRequest, ReadAloudState } from "@t3tools/contracts";

/**
 * Client side of read-aloud (`/api/read-aloud`, see the server's readAloud.ts):
 * starts a job, polls for audio, and plays each chunk as soon as it lands, so
 * the first sentence speaks while the summary is still being written. A chunk
 * covers one or more sentences; the subtitle follows playback within it.
 * Platforms only supply HTTP and audio playback.
 */
export type ReadAloudClip = {
  /** Unique per job and chunk, so a preloaded clip can be recognized. */
  readonly id: string;
  /** Base64 WAV. */
  readonly audio: string;
};

export type ReadAloudPlayOptions = {
  readonly rate: number;
  /** Where to start within the clip, 0..1. */
  readonly startFraction?: number;
  /** The clip after this one, to load while this one plays (no gap between them). */
  readonly next?: ReadAloudClip;
  /** Called with the played fraction, 0..1, a few times a second. */
  readonly onProgress?: (fraction: number) => void;
};

export interface ReadAloudAudio {
  /** Plays one clip; resolves when it ends, rejects if stopped. */
  play(clip: ReadAloudClip, options: ReadAloudPlayOptions): Promise<void>;
  /** Loads the clip that plays next, when it arrives after the current one started. */
  preload?(clip: ReadAloudClip): void;
  /** Changes the pace of the clip that is playing. */
  setRate?(rate: number): void;
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

/** One message's listening, reported when it ends (finished, stopped or replaced). */
export type ReadAloudPlayed = {
  readonly key: string;
  readonly startedAt: number;
  readonly endedAt: number;
  /** Time spent playing; pauses and loading do not count. */
  readonly seconds: number;
};

export type ReadAloudDependencies = {
  readonly request: (body: ReadAloudRequest) => Promise<ReadAloudState>;
  readonly audio: ReadAloudAudio;
  readonly pollMs?: number;
  readonly speed?: number;
  readonly onSpeedChange?: (speed: number) => void;
  readonly onPlayed?: (played: ReadAloudPlayed) => void;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
};

/** Anything shorter is a mis-tap, not listening. */
const MIN_PLAYED_SECONDS = 1;

export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

/** The fastest pace the server's voices synthesize; faster speeds add playback rate on top. */
export const READ_ALOUD_MAX_SYNTH_SPEED = 2;

/** The speed the server synthesizes at for a chosen speed (the rest is playback rate). */
export const synthSpeed = (speed: number) =>
  Math.min(Math.max(speed, 0.5), READ_ALOUD_MAX_SYNTH_SPEED);

/** A stored or picked speed, snapped to the menu's choices. */
export function readAloudSpeed(value: unknown): number {
  const speed = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return READ_ALOUD_SPEEDS.reduce((best, choice) =>
    Math.abs(choice - speed) < Math.abs(best - speed) ? choice : best,
  );
}

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

type Chunk = { readonly audio: string; readonly span: number };

/** A message as it was read: its sentences and their audio (see `ReadAloudPlayer.take`). */
export type ReadAloudTake = {
  readonly key: string;
  readonly mode: ReadAloudMode;
  readonly text: string;
  readonly sentences: readonly string[];
  readonly voice: string;
  readonly jobId: string | null;
  readonly jobSpeed: number;
  readonly chunks: ReadonlyMap<number, Chunk>;
};

export class ReadAloudPlayer {
  #deps: ReadAloudDependencies;
  #state: ReadAloudSnapshot;
  #listeners = new Set<() => void>();
  /** Chunks by the index of their first sentence. */
  #chunks = new Map<number, Chunk>();
  /** First sentence not covered by a received chunk (chunks arrive in order). */
  #covered = 0;
  #session = 0;
  #complete = false;
  #wake: (() => void) | null = null;
  #jobId: string | null = null;
  // The server synthesizes at the speed the job started with; a later change
  // plays the remaining clips faster or slower instead of re-synthesizing.
  #jobSpeed = 1;
  #text = "";
  // The chunk after the one playing, when it had not arrived yet as it started:
  // preloaded the moment it does, so it follows without a gap.
  #awaitingNext: number | null = null;

  constructor(deps: ReadAloudDependencies) {
    this.#deps = deps;
    this.#state = idle(readAloudSpeed(deps.speed ?? 1));
  }

  getSnapshot = (): ReadAloudSnapshot => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<ReadAloudSnapshot>) {
    const before = this.#state;
    this.#state = { ...before, ...patch };
    this.#track(before, this.#state);
    for (const listener of this.#listeners) listener();
  }

  // Playing time of the message being read, summed over its play/pause spans.
  #heard: { startedAt: number; ms: number; since: number | null } | null = null;

  #track(before: ReadAloudSnapshot, after: ReadAloudSnapshot) {
    const onPlayed = this.#deps.onPlayed;
    if (!onPlayed) return;
    const now = (this.#deps.now ?? Date.now)();
    const heard = this.#heard;
    if (heard && before.phase === "playing" && after.phase !== "playing" && heard.since !== null) {
      heard.ms += now - heard.since;
      heard.since = null;
    }
    if (
      heard &&
      before.key !== null &&
      (after.key !== before.key || ["idle", "done", "error"].includes(after.phase))
    ) {
      this.#heard = null;
      const seconds = heard.ms / 1000;
      if (seconds >= MIN_PLAYED_SECONDS) {
        onPlayed({ key: before.key, startedAt: heard.startedAt, endedAt: now, seconds });
      }
    }
    if (after.phase === "playing" && after.key !== null) {
      this.#heard ??= { startedAt: now, ms: 0, since: null };
      this.#heard.since ??= now;
    }
  }

  /** Reads a message from the top; replaces whatever was playing. */
  start(key: string, text: string, mode: ReadAloudMode = "summary") {
    this.#text = text;
    this.#deps.audio.stop();
    const session = ++this.#session;
    this.#chunks = new Map();
    this.#covered = 0;
    this.#complete = false;
    this.#set({ ...idle(this.#state.speed), phase: "loading", key, mode });
    void this.#fetch(session, text, mode);
    void this.#playLoop(session);
  }

  /**
   * The message read last, with every sentence's audio, once it has all
   * arrived: `replay` plays it again from the phone, without asking the server
   * for a new summary. Null while nothing complete is loaded.
   */
  take(): ReadAloudTake | null {
    const { key, mode, sentences, voice } = this.#state;
    if (key === null || !this.#complete || this.#state.phase === "error") return null;
    if (this.#chunks.size === 0 || this.#covered < sentences.length) return null;
    return {
      key,
      mode,
      text: this.#text,
      sentences,
      voice,
      jobId: this.#jobId,
      jobSpeed: this.#jobSpeed,
      chunks: new Map(this.#chunks),
    };
  }

  /** Plays a taken message from the top; replaces whatever was playing. */
  replay(take: ReadAloudTake) {
    this.#deps.audio.stop();
    const session = ++this.#session;
    this.#text = take.text;
    this.#jobId = take.jobId;
    this.#jobSpeed = take.jobSpeed;
    this.#chunks = new Map(take.chunks);
    this.#covered = take.sentences.length;
    this.#complete = true;
    this.#awaitingNext = null;
    this.#set({
      ...idle(this.#state.speed),
      phase: "loading",
      key: take.key,
      mode: take.mode,
      sentences: take.sentences,
      voice: take.voice,
    });
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
    this.#set({ current: target, phase: this.#chunkAt(target) ? "playing" : "loading" });
    if (!this.#complete) void this.#fetchContinue(session);
    void this.#playLoop(session);
  }

  /** Changes the pace: sent to the server with the next message, applied to this one by playback rate. */
  setSpeed(speed: number) {
    this.#set({ speed });
    this.#deps.onSpeedChange?.(speed);
    this.#deps.audio.setRate?.(speed / this.#jobSpeed);
  }

  async #fetch(session: number, text: string, mode: ReadAloudMode) {
    try {
      this.#jobSpeed = synthSpeed(this.#state.speed);
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
      const state = await this.#deps.request({ id: this.#jobId, from: this.#covered });
      if (session !== this.#session) return;
      this.#absorb(state);
    }
  }

  #absorb(state: ReadAloudState) {
    state.sentences.forEach((sentence, index) => {
      if (sentence.audio) {
        this.#chunks.set(index, { audio: sentence.audio, span: sentence.span ?? 1 });
      }
    });
    for (
      let chunk = this.#chunks.get(this.#covered);
      chunk;
      chunk = this.#chunks.get(this.#covered)
    ) {
      this.#covered += chunk.span;
    }
    if (this.#awaitingNext !== null) {
      const next = this.#clip(this.#awaitingNext);
      if (next) {
        this.#awaitingNext = null;
        this.#deps.audio.preload?.(next);
      }
    }
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

  /** The chunk holding a sentence, with the index of its first sentence. */
  #chunkAt(index: number): { readonly first: number; readonly chunk: Chunk } | null {
    for (const [first, chunk] of this.#chunks) {
      if (index >= first && index < first + chunk.span) return { first, chunk };
    }
    return null;
  }

  /** Where each sentence of a chunk ends, as a fraction of the chunk (by characters). */
  #bounds(first: number, span: number): number[] {
    const lengths = this.#state.sentences.slice(first, first + span).map((text) => text.length + 1);
    const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
    let sum = 0;
    return lengths.map((length) => (sum += length) / total);
  }

  #clip(first: number): ReadAloudClip | undefined {
    const chunk = this.#chunks.get(first);
    return chunk && { id: `${this.#jobId}:${first}`, audio: chunk.audio };
  }

  async #playLoop(session: number) {
    while (session === this.#session) {
      const index = this.#state.current;
      const found = this.#chunkAt(index);
      if (!found) {
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
      const { first, chunk } = found;
      const bounds = this.#bounds(first, chunk.span);
      const startFraction = index > first ? (bounds[index - first - 1] ?? 0) : 0;
      const clip = this.#clip(first);
      const next = this.#clip(first + chunk.span);
      if (!clip) return;
      this.#set({ phase: "playing" });
      this.#awaitingNext = next ? null : first + chunk.span;
      try {
        await this.#deps.audio.play(clip, {
          rate: this.#state.speed / this.#jobSpeed,
          startFraction,
          ...(next ? { next } : {}),
          onProgress: (fraction) => {
            if (session !== this.#session) return;
            const within = bounds.findIndex((bound) => fraction < bound);
            const current = first + (within === -1 ? chunk.span - 1 : within);
            if (current !== this.#state.current) this.#set({ current });
          },
        });
      } catch {
        return;
      }
      if (session !== this.#session) return;
      this.#set({ current: first + chunk.span });
    }
  }
}
