// @effect-diagnostics globalDate:off -- Plain timestamps, shared with React Native; no Effect runtime here.
// @effect-diagnostics globalTimers:off -- Plain timers, shared with React Native; no Effect runtime here.
import type { ActivityEvent } from "@t3tools/contracts";

import type { ReadAloudPlayed } from "./readAloud.ts";
import { VOICE_LOOP_CUE_KEY, type VoiceLoopSpan } from "./voiceLoop.ts";

/**
 * Client side of `/api/activity` (the server's activityLog.ts): the shapes a
 * client reports, and a reporter that says which thread has the user's
 * attention. Platforms only supply the HTTP post.
 */
export type ActivityClient = "web" | "desktop" | "mobile";

export type ActivitySender = (event: ActivityEvent) => Promise<void> | void;

const iso = (ms: number) => new Date(ms).toISOString();

/** The spoken cue that opens each voice-mode turn is not a message anyone read. */
export function readAloudEvent(
  played: ReadAloudPlayed,
  client: ActivityClient,
): ActivityEvent | null {
  if (played.key === VOICE_LOOP_CUE_KEY) return null;
  return {
    kind: "t3.readaloud.played",
    messageId: played.key,
    client,
    startedAt: iso(played.startedAt),
    endedAt: iso(played.endedAt),
    seconds: Math.round(played.seconds * 10) / 10,
  };
}

export function voiceModeEvent(span: VoiceLoopSpan, client: ActivityClient): ActivityEvent {
  return {
    kind: "t3.voicemode.span",
    ...(span.threadId ? { threadId: span.threadId } : {}),
    client,
    startedAt: iso(span.startedAt),
    endedAt: iso(span.endedAt),
  };
}

/** Reports are best effort: a failed one is dropped, never retried into a queue. */
export function sendQuietly(send: ActivitySender, event: ActivityEvent | null) {
  if (!event) return;
  void Promise.resolve()
    .then(() => send(event))
    .catch(() => undefined);
}

const FOCUS_SETTLE_MS = 5_000;
const FOCUS_BEAT_MS = 60_000;

/**
 * Which thread has the user's attention. A thread must stay in front for
 * `settleMs` before it counts (skimming past a list of threads is not focus),
 * and then it is reported again every `beatMs` while it stays, so the tracker
 * can lay minutes of attention on projects. `focus(null)` is a hidden window
 * or a closed thread.
 */
export class FocusReporter {
  #send: ActivitySender;
  #client: ActivityClient;
  #settleMs: number;
  #beatMs: number;
  #now: () => number;
  #thread: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    readonly send: ActivitySender;
    readonly client: ActivityClient;
    readonly settleMs?: number;
    readonly beatMs?: number;
    readonly now?: () => number;
  }) {
    this.#send = options.send;
    this.#client = options.client;
    this.#settleMs = options.settleMs ?? FOCUS_SETTLE_MS;
    this.#beatMs = options.beatMs ?? FOCUS_BEAT_MS;
    this.#now = options.now ?? Date.now;
  }

  focus(threadId: string | null) {
    if (threadId === this.#thread) return;
    this.#thread = threadId;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (threadId) this.#schedule(threadId, this.#settleMs);
  }

  #schedule(threadId: string, delay: number) {
    this.#timer = setTimeout(() => {
      if (this.#thread !== threadId) return;
      sendQuietly(this.#send, {
        kind: "thread.focus",
        threadId,
        client: this.#client,
        at: iso(this.#now()),
      });
      this.#schedule(threadId, this.#beatMs);
    }, delay);
  }
}
