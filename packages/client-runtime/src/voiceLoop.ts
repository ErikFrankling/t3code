import type { ReadAloudPlayer, ReadAloudTake } from "./readAloud.ts";

/**
 * Voice mode's conversation loop, shared by web, desktop and the phone: read
 * the agent's reply aloud, say "Recording started", dictate, end the turn
 * (a button, a volume key, an earbud tap), send, wait for the reply, repeat.
 * The platform supplies dictation and tells the loop what the thread shows.
 */
export type VoiceLoopPhase = "off" | "cue" | "listening" | "sending" | "waiting" | "reading";

export type VoiceLoopReply = { readonly key: string; readonly text: string };

export type VoiceLoopThread = {
  /** The thread being talked to, for the span reported when the loop ends. */
  readonly threadId?: string;
  /** The latest finished assistant message. */
  readonly reply: VoiceLoopReply | null;
  /** The agent is still on its turn (intermediate messages are not read). */
  readonly working: boolean;
};

export type VoiceLoopSnapshot = {
  readonly phase: VoiceLoopPhase;
  readonly error: string | null;
};

export type VoiceLoopSpan = {
  readonly threadId: string | null;
  readonly startedAt: number;
  readonly endedAt: number;
};

export type VoiceLoopDependencies = {
  readonly player: ReadAloudPlayer;
  /** Starts dictation into the thread's composer. */
  readonly listen: () => Promise<void> | void;
  /** Ends dictation and sends what was said. */
  readonly send: () => Promise<void> | void;
  /**
   * Plays a short sound that says the microphone is on, without the read-aloud
   * player (its controls would flash for it). Without it the cue is spoken.
   */
  readonly cue?: () => Promise<void> | void;
  /** Called when the loop turns off, with how long it was on. */
  readonly onSpan?: (span: VoiceLoopSpan) => void;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
};

export const VOICE_LOOP_CUE = "Recording started.";
/** The read-aloud key of the cue, so views can leave it out once it was said. */
export const VOICE_LOOP_CUE_KEY = "voice-loop:cue";
const CUE_KEY = VOICE_LOOP_CUE_KEY;

export class VoiceLoop {
  #deps: VoiceLoopDependencies;
  #state: VoiceLoopSnapshot = { phase: "off", error: null };
  #listeners = new Set<() => void>();
  #thread: VoiceLoopThread = { reply: null, working: false };
  /** The reply that was already there when this turn started; it is not read again. */
  #heard: string | null = null;
  /** The reply read last and, once it had all arrived, its audio: kept until the next reply. */
  #lastReply: VoiceLoopReply | null = null;
  #take: ReadAloudTake | null = null;
  #run = 0;

  constructor(deps: VoiceLoopDependencies) {
    this.#deps = deps;
  }

  getSnapshot = (): VoiceLoopSnapshot => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  // When the loop came on and the thread it talked to, for `onSpan`.
  #on: { startedAt: number; threadId: string | null } | null = null;

  #set(patch: Partial<VoiceLoopSnapshot>) {
    const wasOff = this.#state.phase === "off";
    this.#state = { ...this.#state, ...patch };
    this.#trackSpan(wasOff);
    for (const listener of this.#listeners) listener();
  }

  #trackSpan(wasOff: boolean) {
    const now = (this.#deps.now ?? Date.now)();
    const isOff = this.#state.phase === "off";
    if (wasOff && !isOff) this.#on = { startedAt: now, threadId: this.#thread.threadId ?? null };
    else if (!wasOff && isOff && this.#on) {
      const { startedAt, threadId } = this.#on;
      this.#on = null;
      this.#deps.onSpan?.({ threadId: this.#thread.threadId ?? threadId, startedAt, endedAt: now });
    }
  }

  get active(): boolean {
    return this.#state.phase !== "off";
  }

  /** Turns the loop on. A reply being read finishes first; then it listens. */
  start() {
    if (this.active) return;
    const run = ++this.#run;
    this.#set({ error: null });
    const playing = this.#deps.player.getSnapshot();
    if (playing.key && playing.key !== CUE_KEY && isSpeaking(playing.phase)) {
      this.#heard = playing.key;
      if (this.#thread.reply?.key === playing.key) this.#remember(this.#thread.reply);
      this.#set({ phase: "reading" });
      void this.#played(playing.key).then(() => {
        this.#keep();
        if (run === this.#run) void this.#listen(run);
      });
      return;
    }
    void this.#listen(run);
  }

  /** Turns the loop off; a dictation in progress stays in the composer. */
  stop() {
    this.#run++;
    const phase = this.#state.phase;
    if (phase === "reading" || phase === "cue") this.#deps.player.stop();
    this.#set({ phase: "off" });
  }

  /** What the thread shows now; called whenever it changes. */
  update(thread: VoiceLoopThread) {
    this.#thread = thread;
    if (this.#on) this.#on.threadId = thread.threadId ?? this.#on.threadId;
    if (this.#state.phase === "waiting") this.#readReply(this.#run);
  }

  /**
   * One control for the whole loop: while listening it sends; while the reply
   * is read, or while waiting for it, it starts your turn (a message that never
   * went out, such as silence, would otherwise leave the loop waiting forever).
   */
  endTurn() {
    const phase = this.#state.phase;
    if (phase === "listening") void this.#send(this.#run);
    else if (phase === "reading" || phase === "waiting") {
      const run = ++this.#run;
      if (phase === "reading") {
        this.#keep();
        this.#deps.player.stop();
      }
      void this.#listen(run);
    }
  }

  /**
   * Plays the last reply again from the top (a volume-up press), from its audio
   * kept on the device until the next reply arrives; then it is your turn. On
   * your turn it plays over the recording, which goes on.
   */
  replay() {
    const phase = this.#state.phase;
    const reply = this.#lastReply;
    if (!reply) return;
    if (phase === "cue" || phase === "listening") {
      // Your turn is already being recorded: the reply plays over it (the call
      // cancels its own sound from the microphone) and the recording goes on,
      // so nothing said is lost; the turn button still sends.
      this.#playReply(reply);
      return;
    }
    if (phase !== "reading" && phase !== "waiting") return;
    if (phase === "reading") this.#keep();
    const run = ++this.#run;
    this.#set({ phase: "reading" });
    this.#playReply(reply);
    void this.#played(reply.key).then(() => {
      if (run !== this.#run || this.#state.phase !== "reading") return;
      this.#keep();
      if (phase === "waiting") {
        // Still waiting for the answer to what you sent: read it once it is there.
        this.#set({ phase: "waiting" });
        this.#readReply(run);
      } else void this.#listen(run);
    });
  }

  /** The dictation was sent some other way (the composer's own button). */
  sent() {
    if (this.#state.phase === "listening" || this.#state.phase === "sending") {
      this.#set({ phase: "waiting" });
      this.#readReply(this.#run);
    }
  }

  /**
   * Your turn: recording starts right away and the cue plays over it. Waiting
   * for the cue first lost the start of what was said (Erik starts talking as
   * it plays): his "what's next?" reached the recognizer as half a second of
   * audio and came back "[Unintelligible Speech]".
   */
  async #listen(run: number) {
    this.#heard = this.#thread.reply?.key ?? this.#heard;
    this.#set({ phase: "cue" });
    const listening = (async () => this.#deps.listen())();
    void this.#playCue();
    try {
      await listening;
      if (run === this.#run && this.#state.phase === "cue") this.#set({ phase: "listening" });
    } catch (error) {
      if (run === this.#run) this.#fail(error);
    }
  }

  async #playCue() {
    if (this.#deps.cue) {
      await Promise.resolve()
        .then(() => this.#deps.cue?.())
        .catch(() => undefined);
      return;
    }
    this.#deps.player.start(CUE_KEY, VOICE_LOOP_CUE, "full");
    await this.#played(CUE_KEY);
    // Said; the read-aloud panels go back to the reply instead of showing it.
    if (this.#deps.player.getSnapshot().key === CUE_KEY) this.#deps.player.stop();
  }

  async #send(run: number) {
    this.#set({ phase: "sending" });
    try {
      await this.#deps.send();
    } catch (error) {
      if (run === this.#run) this.#fail(error);
      return;
    }
    if (run === this.#run && this.#state.phase === "sending") {
      this.#set({ phase: "waiting" });
      this.#readReply(run);
    }
  }

  #readReply(run: number) {
    const { reply, working } = this.#thread;
    if (working || !reply || reply.key === this.#heard) return;
    this.#heard = reply.key;
    this.#remember(reply);
    this.#set({ phase: "reading" });
    this.#deps.player.start(reply.key, reply.text, "summary");
    void this.#played(reply.key).then(() => {
      this.#keep();
      if (run === this.#run && this.#state.phase === "reading") void this.#listen(run);
    });
  }

  /** The reply from the top: from its kept audio when the player has all of it. */
  #playReply(reply: VoiceLoopReply) {
    if (this.#take?.key === reply.key) this.#deps.player.replay(this.#take);
    else this.#deps.player.start(reply.key, reply.text, "summary");
  }

  /** A new reply replaces the kept one. */
  #remember(reply: VoiceLoopReply) {
    if (this.#lastReply?.key === reply.key) return;
    this.#lastReply = reply;
    this.#take = null;
  }

  /** Keeps the last reply's audio once the player has all of it. */
  #keep() {
    const take = this.#deps.player.take();
    if (take && take.key === this.#lastReply?.key) this.#take = take;
  }

  #fail(error: unknown) {
    this.#run++;
    this.#set({ phase: "off", error: error instanceof Error ? error.message : String(error) });
  }

  /** Resolves once the player is done with `key`: finished, failed, stopped or replaced. */
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

const isSpeaking = (phase: string) =>
  phase === "loading" || phase === "playing" || phase === "paused";

let cueWav: string | null = null;

/**
 * Voice mode's "recording" sound as a base64 WAV: two short rising tones,
 * about a quarter of a second. No words, so nothing of it is transcribed, and
 * short, so it is over before a sentence starts.
 */
export function voiceLoopCueWav(): string {
  if (cueWav) return cueWav;
  const rate = 24000;
  const tones = [
    { hz: 880, ms: 90 },
    { hz: 0, ms: 30 },
    { hz: 1320, ms: 120 },
  ];
  const samples: number[] = [];
  for (const tone of tones) {
    const count = Math.round((rate * tone.ms) / 1000);
    for (let index = 0; index < count; index++) {
      // A short fade in and out keeps the tones from clicking.
      const edge = Math.min(1, index / 240, (count - index) / 240);
      const value = tone.hz ? Math.sin((2 * Math.PI * tone.hz * index) / rate) * 0.3 * edge : 0;
      samples.push(Math.round(value * 32767));
    }
  }
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  cueWav = base64(bytes);
  return cueWav;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    out += BASE64[a >> 2]! + BASE64[((a & 3) << 4) | (b >> 4)]!;
    out += index + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)]! : "=";
    out += index + 2 < bytes.length ? BASE64[c & 63]! : "=";
  }
  return out;
}
