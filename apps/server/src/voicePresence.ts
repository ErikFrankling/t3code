// @effect-diagnostics globalDate:off globalTimers:off -- A plain in-memory store, like readAloud.ts; its clock is injected for tests.
/**
 * Voice presence: which phone has voice mode on, for which thread, and the
 * agent's spoken messages waiting to be played there.
 *
 * Erik's phone in voice mode means "you may speak to me now". While it is on,
 * the phone long-polls `POST /api/voice-presence`; the PC's speak daemon asks
 * `GET /api/voice-presence` before it speaks and, when the phone is there,
 * hands the message over with `POST /api/voice-presence/say` instead of
 * playing it on the PC's speakers. The phone reports each message played or
 * skipped on its next poll. Outside voice mode nothing is ever queued for the
 * phone: `say` refuses when no phone is present.
 *
 * In memory on purpose: a restart ends every voice mode session anyway (the
 * phone's next poll starts a new one), and an unplayed message is only worth
 * saying for a few minutes.
 */

/** A poll in flight, or one that ended this recently, counts as present. */
export const PRESENCE_TTL_MS = 15_000;
export const MAX_WAIT_MS = 25_000;
/** Not played by then: the moment has passed. */
export const UTTERANCE_TTL_MS = 10 * 60_000;
/** Handed to a poll whose answer may have been lost: offered again after this. */
const REDELIVER_MS = 30_000;

export type UtteranceStatus = "queued" | "delivered" | "played" | "skipped" | "expired";

export type Utterance = {
  readonly id: string;
  readonly text: string;
  /** The words it was made from (the speak tool's text), so the chat can highlight it. */
  readonly source?: string | undefined;
  readonly threadId: string;
  readonly createdAt: number;
};

type Entry = Utterance & {
  deviceId: string;
  status: UtteranceStatus;
  deliveredAt: number | null;
};

type Device = {
  deviceId: string;
  threadId: string;
  lastSeenAt: number;
  polls: number;
  wake: Set<() => void>;
};

export type Presence = {
  readonly present: boolean;
  readonly deviceId: string | null;
  readonly threadId: string | null;
  readonly lastSeenAt: number | null;
};

export type Beat = {
  readonly deviceId: string;
  readonly threadId: string;
  /** false: voice mode was turned off; the phone is gone at once. */
  readonly on: boolean;
  readonly done?:
    | ReadonlyArray<{ readonly id: string; readonly status: "played" | "skipped" }>
    | undefined;
  /** Hold the request this long for a message (0: answer at once). */
  readonly waitMs?: number | undefined;
};

type Clock = {
  readonly now: () => number;
  readonly setTimeout: (run: () => void, ms: number) => () => void;
};

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

export class VoicePresence {
  #clock: Clock;
  #devices = new Map<string, Device>();
  #utterances = new Map<string, Entry>();

  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  #isPresent(device: Device, now: number) {
    return device.polls > 0 || now - device.lastSeenAt < PRESENCE_TTL_MS;
  }

  /** The phone that most recently had voice mode on, if it still does. */
  presence(): Presence {
    const now = this.#clock.now();
    let latest: Device | null = null;
    for (const device of this.#devices.values()) {
      if (!this.#isPresent(device, now)) continue;
      if (!latest || device.lastSeenAt > latest.lastSeenAt) latest = device;
    }
    return latest
      ? {
          present: true,
          deviceId: latest.deviceId,
          threadId: latest.threadId,
          lastSeenAt: latest.lastSeenAt,
        }
      : { present: false, deviceId: null, threadId: null, lastSeenAt: null };
  }

  /** Queues a message for the phone in voice mode on `threadId`; null when there is none. */
  say(utterance: Omit<Utterance, "createdAt">): UtteranceStatus | null {
    const existing = this.#utterances.get(utterance.id);
    if (existing) return existing.status;
    const now = this.#clock.now();
    let target: Device | null = null;
    for (const device of this.#devices.values()) {
      if (device.threadId !== utterance.threadId || !this.#isPresent(device, now)) continue;
      if (!target || device.lastSeenAt > target.lastSeenAt) target = device;
    }
    if (!target) return null;
    this.#prune(now);
    this.#utterances.set(utterance.id, {
      ...utterance,
      createdAt: now,
      deviceId: target.deviceId,
      status: "queued",
      deliveredAt: null,
    });
    for (const wake of target.wake) wake();
    return "queued";
  }

  status(id: string): UtteranceStatus | null {
    const entry = this.#utterances.get(id);
    if (!entry) return null;
    this.#expire(entry, this.#clock.now());
    return entry.status;
  }

  /** One poll from the phone: reports what it played, then waits for something to say. */
  async beat(beat: Beat): Promise<ReadonlyArray<Utterance>> {
    const now = this.#clock.now();
    for (const report of beat.done ?? []) {
      const entry = this.#utterances.get(report.id);
      if (entry && entry.status !== "expired") entry.status = report.status;
    }
    if (!beat.on) {
      this.#devices.delete(beat.deviceId);
      for (const entry of this.#utterances.values()) {
        if (entry.deviceId === beat.deviceId && entry.status === "queued") entry.status = "skipped";
      }
      return [];
    }
    let device = this.#devices.get(beat.deviceId);
    if (!device || device.threadId !== beat.threadId) {
      device = {
        deviceId: beat.deviceId,
        threadId: beat.threadId,
        lastSeenAt: now,
        polls: device?.polls ?? 0,
        wake: device?.wake ?? new Set(),
      };
      this.#devices.set(beat.deviceId, device);
    }
    device.lastSeenAt = now;
    const waitMs = Math.max(0, Math.min(beat.waitMs ?? 0, MAX_WAIT_MS));
    let ready = this.#take(device);
    if (ready.length === 0 && waitMs > 0) {
      device.polls++;
      await new Promise<void>((resolve) => {
        const done = () => {
          cancel();
          device.wake.delete(done);
          resolve();
        };
        const cancel = this.#clock.setTimeout(done, waitMs);
        device.wake.add(done);
      });
      device.polls--;
      device.lastSeenAt = this.#clock.now();
      ready = this.#take(device);
    }
    return ready;
  }

  #take(device: Device): Utterance[] {
    const now = this.#clock.now();
    const out: Utterance[] = [];
    for (const entry of this.#utterances.values()) {
      if (entry.deviceId !== device.deviceId) continue;
      this.#expire(entry, now);
      const due =
        entry.status === "queued" ||
        (entry.status === "delivered" &&
          entry.deliveredAt !== null &&
          now - entry.deliveredAt >= REDELIVER_MS);
      if (!due) continue;
      entry.status = "delivered";
      entry.deliveredAt = now;
      out.push({
        id: entry.id,
        text: entry.text,
        source: entry.source,
        threadId: entry.threadId,
        createdAt: entry.createdAt,
      });
    }
    return out;
  }

  #expire(entry: Entry, now: number) {
    if (
      (entry.status === "queued" || entry.status === "delivered") &&
      now - entry.createdAt > UTTERANCE_TTL_MS
    ) {
      entry.status = "expired";
    }
  }

  #prune(now: number) {
    for (const [id, entry] of this.#utterances) {
      if (now - entry.createdAt > 2 * UTTERANCE_TTL_MS) this.#utterances.delete(id);
    }
  }
}

export const voicePresence = new VoicePresence();
