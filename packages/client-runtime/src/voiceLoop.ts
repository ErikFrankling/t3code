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
   * kept on the device until the next reply arrives; then it is your turn. While
   * you talk it does nothing, so a press never costs what you said.
   */
  replay() {
    const phase = this.#state.phase;
    if (phase !== "reading" && phase !== "waiting" && phase !== "cue") return;
    const reply = this.#lastReply;
    if (!reply) return;
    if (phase === "reading") this.#keep();
    const run = ++this.#run;
    this.#set({ phase: "reading" });
    if (this.#take?.key === reply.key) this.#deps.player.replay(this.#take);
    else this.#deps.player.start(reply.key, reply.text, "summary");
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

  async #listen(run: number) {
    this.#heard = this.#thread.reply?.key ?? this.#heard;
    this.#set({ phase: "cue" });
    this.#deps.player.start(CUE_KEY, VOICE_LOOP_CUE, "full");
    await this.#played(CUE_KEY);
    // Said; the read-aloud panels go back to the reply instead of showing it.
    if (this.#deps.player.getSnapshot().key === CUE_KEY) this.#deps.player.stop();
    if (run !== this.#run) return;
    try {
      await this.#deps.listen();
      if (run === this.#run && this.#state.phase === "cue") this.#set({ phase: "listening" });
    } catch (error) {
      if (run === this.#run) this.#fail(error);
    }
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
