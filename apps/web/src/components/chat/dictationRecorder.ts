import type { DictationRequest, DictationState } from "@t3tools/contracts";

import type { DictationRecord, DictationStorage } from "./dictationStorage";

/**
 * Voice input is never lost. Every chunk is written to the device before it is
 * uploaded; a separate loop per recording drains the stored chunks to the
 * speech service in order and retries for as long as the page is open, and
 * picks up again on the next page load. The device copy is removed only after
 * the server reported the message `sent`, the transcript went into the
 * composer (Edit), or the user confirmed Delete. Nothing here ever cancels a
 * recording because of an error, a reload or a closed view.
 */

export class DictationHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type DictationUpload = "uploaded" | "uploading" | "waiting";

export interface DictationEntry {
  readonly record: DictationRecord;
  readonly upload: DictationUpload;
  /** The latest transient problem, in plain words; cleared by the next success. */
  readonly error: string;
  /** Saving to the device failed: the audio is only in this tab's memory. */
  readonly unsaved: boolean;
}

/** Hands a stopped recording to the chat, which sends it once the transcript exists. */
export type DictationHandoff = (
  serverId: string,
  draft: string,
  uploaded: Promise<void>,
) => Promise<void>;

interface Dependencies {
  readonly storage: DictationStorage;
  readonly request: (environmentId: string, body: DictationRequest) => Promise<DictationState>;
  readonly newId: () => string;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  /**
   * Holds a recording for this tab until the returned promise settles, so two
   * tabs never drive the same recording (Web Locks in the browser). A queued
   * request is granted when the other tab closes.
   */
  readonly lock?: (name: string, hold: () => Promise<void>) => void;
}

interface Live {
  record: DictationRecord;
  cache: Map<number, Int16Array>;
  unsaved: Set<number>;
  failures: number;
  error: string;
  storageError: boolean;
  gone: boolean;
  finished: () => void;
  wake: () => void;
  handoff: Promise<void> | null;
  finishRequested: boolean;
  /** When the server last reported this recording's transcript. */
  heard: number;
  uploadWaiters: Set<{ serverId: string; resolve: () => void; reject: (cause: Error) => void }>;
}

const SAMPLE_RATE = 16000;
const SETTLED = new Set(["complete", "error", "cancelled"]);

export const recordingSeconds = (record: DictationRecord) =>
  record.sizes.reduce((total, size) => total + size, 0) / 2 / SAMPLE_RATE;

const hasAudio = (record: DictationRecord) => record.sizes.some((size) => size > 0);

function encode(samples: Int16Array) {
  let binary = "";
  for (const byte of new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
    binary += String.fromCharCode(byte);
  return btoa(binary);
}

const statusOf = (cause: unknown) => (cause instanceof DictationHttpError ? cause.status : 0);

export function plainDictationError(cause: unknown): string {
  const status = statusOf(cause);
  if (status === 401 || status === 403) return "This device is not signed in to the server.";
  if (status === 0 || status === 408 || status >= 500)
    return "The speech service is not reachable right now.";
  return `The speech service refused a request (HTTP ${status}).`;
}

const backoff = (failures: number) => Math.min(30_000, 500 * 2 ** Math.min(failures, 6));

function browserLock(name: string, hold: () => Promise<void>) {
  if (typeof navigator !== "undefined" && navigator.locks) {
    void navigator.locks.request(name, hold).catch(() => undefined);
  } else void hold();
}

export class DictationRecorder {
  readonly #deps: Dependencies;
  readonly #live = new Map<string, Live>();
  readonly #listeners = new Set<() => void>();
  readonly #editors = new Map<string, (text: string) => boolean>();
  readonly #watched = new Map<string, number>();
  readonly #claiming = new Set<string>();
  readonly #returned = new Set<(serverId: string) => void>();
  #snapshot: readonly DictationEntry[] = [];
  #loaded: Promise<void> | null = null;

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = () => this.#snapshot;

  /**
   * Called with the server id of a sent recording that came back unsent (no
   * speech, or the server lost it), so the chat can drop its pending bubble.
   */
  onReturned(listener: (serverId: string) => void) {
    this.#returned.add(listener);
    return () => {
      this.#returned.delete(listener);
    };
  }

  /** Adopts every recording left on this device by an earlier page. */
  load(): Promise<void> {
    this.#loaded ??= this.rescan();
    return this.#loaded;
  }

  /**
   * Also adopts recordings another window made after this page loaded (the
   * speak-reply window). A recording that window still holds is adopted when
   * it lets go of it.
   */
  rescan(): Promise<void> {
    return this.#deps.storage.listRecords().then((records) => {
      for (const { id } of records) {
        if (this.#live.has(id) || this.#claiming.has(id)) continue;
        this.#claiming.add(id);
        this.#lock(id, async () => {
          this.#claiming.delete(id);
          const record = await this.#deps.storage.getRecord(id);
          if (!record || this.#live.has(id)) return;
          // The tab that held the microphone is gone; the recording stays open.
          await this.#adopt(record.state === "recording" ? { ...record, state: "paused" } : record);
        });
      }
    });
  }

  /** The composer that takes an edited transcript for this target. */
  registerEditor(target: string, insert: (text: string) => boolean) {
    this.#editors.set(target, insert);
    for (const live of this.#live.values()) if (live.record.target === target) live.wake();
    return () => {
      if (this.#editors.get(target) === insert) this.#editors.delete(target);
    };
  }

  /** Keeps a paused recording's transcript fresh while someone looks at it. */
  watch(id: string) {
    this.#watched.set(id, (this.#watched.get(id) ?? 0) + 1);
    this.#live.get(id)?.wake();
    return () => {
      const count = (this.#watched.get(id) ?? 1) - 1;
      if (count > 0) this.#watched.set(id, count);
      else this.#watched.delete(id);
    };
  }

  async create(input: {
    target: string;
    environmentId: string;
    project: string;
    threadId: string | null;
  }): Promise<string> {
    const id = this.#deps.newId();
    const record: DictationRecord = {
      id,
      serverId: id,
      ...input,
      createdAt: this.#now(),
      state: "recording",
      sizes: [],
      uploaded: 0,
      registered: false,
      handedOff: false,
      server: null,
      notice: "",
    };
    const finished = this.#adopt(record);
    this.#lock(id, () => finished);
    await this.#save(this.#live.get(id)!);
    return id;
  }

  /** Stores a chunk; resolves once it is on the device (or kept in memory if that failed). */
  append(id: string, samples: Int16Array): Promise<void> {
    const live = this.#live.get(id);
    // Only a recording that records grows: a paused or sent one never takes
    // audio, whatever microphone is still feeding it.
    if (!live || live.gone || samples.length === 0 || live.record.state !== "recording")
      return Promise.resolve();
    const sequence = live.record.sizes.length;
    live.cache.set(sequence, samples);
    live.unsaved.add(sequence);
    this.#update(live, { sizes: [...live.record.sizes, samples.byteLength] });
    const snapshot = live.record;
    live.wake();
    return this.#deps.storage.putChunk(snapshot, sequence, samples).then(
      () => {
        live.unsaved.delete(sequence);
        if (sequence < live.record.uploaded) live.cache.delete(sequence);
        if (live.storageError && live.unsaved.size === 0) {
          live.storageError = false;
          this.#publish();
        }
      },
      () => {
        live.storageError = true;
        this.#publish();
      },
    );
  }

  /** `notice` says why, when it was not the user who paused it. */
  pause(id: string, notice = "") {
    this.#transition(id, ["recording"], "paused", notice);
  }

  resume(id: string) {
    this.#transition(id, ["paused"], "recording");
  }

  /**
   * Hands the recording to the chat now, so the chat captures its destination,
   * model and typed text. The chat waits for `uploaded`, which settles only
   * when the server holds every chunk.
   */
  async send(id: string, handoff: DictationHandoff): Promise<void> {
    const live = this.#live.get(id);
    if (!live || live.gone) return;
    if (live.record.state !== "recording" && live.record.state !== "paused") return;
    if (!hasAudio(live.record)) return this.#forget(live);
    const { serverId } = live.record;
    this.#update(live, { state: "sending", notice: "", handedOff: false });
    const uploaded = this.#whenUploaded(live, serverId);
    // Called before any await: the worker must see the handoff in progress,
    // and the chat snapshots its composer synchronously.
    const handing = handoff(serverId, live.record.server?.draft ?? "", uploaded);
    live.handoff = handing;
    live.wake();
    try {
      await this.#save(live);
      await handing;
      if (live.gone) return;
      this.#update(live, { handedOff: true });
    } catch (cause) {
      if (live.gone) return;
      this.#update(live, {
        state: "paused",
        notice: `Not sent: ${cause instanceof Error ? cause.message : String(cause)} The recording is kept on this device.`,
      });
    } finally {
      live.handoff = null;
      await this.#save(live);
      live.wake();
    }
  }

  /** Finishes the recording and puts the final transcript into the composer instead of sending. */
  async edit(id: string) {
    const live = this.#live.get(id);
    if (!live || live.gone) return;
    if (live.record.state !== "recording" && live.record.state !== "paused") return;
    if (!hasAudio(live.record)) return this.#forget(live);
    this.#update(live, { state: "edited", notice: "" });
    await this.#save(live);
    live.wake();
  }

  /** Explicit, confirmed deletion: the only way audio leaves the device unsent. */
  async remove(id: string) {
    const live = this.#live.get(id);
    if (!live || live.gone) return;
    const { record } = live;
    await this.#forget(live);
    // Stops the speech service's work on it; the service keeps the audio.
    if (record.registered && !record.handedOff)
      void this.#deps
        .request(record.environmentId, { action: "cancel", id: record.serverId })
        .catch(() => undefined);
  }

  /** Every stored chunk, for saving the audio as a file. */
  async audio(id: string): Promise<Int16Array[]> {
    const live = this.#live.get(id);
    if (!live) return [];
    const chunks: Int16Array[] = [];
    for (let sequence = 0; sequence < live.record.sizes.length; sequence++)
      chunks.push(await this.#chunk(live, sequence));
    return chunks;
  }

  #lock(id: string, hold: () => Promise<void>) {
    (this.#deps.lock ?? browserLock)(`t3-dictation:${id}`, hold);
  }

  #adopt(record: DictationRecord): Promise<void> {
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const live: Live = {
      record,
      cache: new Map(),
      unsaved: new Set(),
      failures: 0,
      error: "",
      storageError: false,
      gone: false,
      finished,
      wake: () => undefined,
      handoff: null,
      finishRequested: false,
      heard: 0,
      uploadWaiters: new Set(),
    };
    this.#live.set(record.id, live);
    this.#publish();
    void this.#run(live);
    return done;
  }

  #transition(
    id: string,
    from: DictationRecord["state"][],
    to: DictationRecord["state"],
    notice = "",
  ) {
    const live = this.#live.get(id);
    if (!live || live.gone || !from.includes(live.record.state)) return;
    this.#update(live, { state: to, notice });
    void this.#save(live);
    live.wake();
  }

  #update(live: Live, patch: Partial<DictationRecord>) {
    live.record = { ...live.record, ...patch };
    this.#settleWaiters(live);
    this.#publish();
  }

  async #save(live: Live) {
    if (live.gone) return;
    try {
      await this.#deps.storage.putRecord(live.record);
    } catch {
      live.storageError = true;
      this.#publish();
    }
  }

  #publish() {
    this.#snapshot = [...this.#live.values()]
      .filter((live) => !live.gone)
      .map((live) => ({
        record: live.record,
        upload:
          live.record.uploaded >= live.record.sizes.length && live.record.registered
            ? "uploaded"
            : live.failures >= 2
              ? "waiting"
              : "uploading",
        error: live.error,
        unsaved: live.storageError,
      }));
    for (const listener of this.#listeners) listener();
  }

  #whenUploaded(live: Live, serverId: string) {
    return new Promise<void>((resolve, reject) => {
      live.uploadWaiters.add({ serverId, resolve, reject });
      this.#settleWaiters(live);
    });
  }

  #settleWaiters(live: Live) {
    const { record } = live;
    for (const waiter of live.uploadWaiters) {
      if (live.gone) waiter.reject(new Error("The recording was deleted."));
      else if (waiter.serverId !== record.serverId)
        waiter.reject(
          new Error("The speech service lost the recording; it is being uploaded again."),
        );
      else if (
        record.state !== "recording" &&
        record.state !== "paused" &&
        record.registered &&
        record.uploaded >= record.sizes.length
      )
        waiter.resolve();
      else continue;
      live.uploadWaiters.delete(waiter);
    }
  }

  async #forget(live: Live) {
    live.gone = true;
    this.#settleWaiters(live);
    live.wake();
    this.#live.delete(live.record.id);
    this.#publish();
    try {
      await this.#deps.storage.deleteRecording(live.record.id);
    } finally {
      live.finished();
    }
  }

  #sleep(live: Live, milliseconds?: number) {
    return new Promise<void>((resolve) => {
      live.wake = resolve;
      if (milliseconds !== undefined)
        void (this.#deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
          milliseconds,
        ).then(resolve);
    });
  }

  async #chunk(live: Live, sequence: number) {
    const cached = live.cache.get(sequence);
    if (cached) return cached;
    const stored = await this.#deps.storage.getChunk(live.record.id, sequence);
    // A chunk the device cannot read back is sent as silence of the same
    // length, so the rest of the recording keeps its place.
    return stored ?? new Int16Array((live.record.sizes[sequence] ?? 0) / 2);
  }

  #now() {
    return (this.#deps.now ?? Date.now)();
  }

  #accept(live: Live, state: DictationState) {
    live.heard = this.#now();
    this.#update(live, {
      server: {
        status: state.status,
        draft: state.draft,
        final: state.final,
        error: state.error,
        ...(state.delivery ? { delivery: state.delivery } : {}),
      },
    });
  }

  #request(live: Live, body: DictationRequest) {
    return this.#deps.request(live.record.environmentId, body);
  }

  /** Starts a fresh server recording and uploads all audio into it again. */
  #continueElsewhere(live: Live) {
    this.#update(live, {
      serverId: this.#deps.newId(),
      uploaded: 0,
      registered: false,
      handedOff: false,
      server: null,
    });
    live.finishRequested = false;
    return this.#save(live);
  }

  async #run(live: Live) {
    while (!live.gone) {
      try {
        const busy = await this.#step(live);
        if (live.failures || live.error) {
          live.failures = 0;
          live.error = "";
          this.#publish();
        }
        if (busy === "idle") await this.#sleep(live);
        else if (typeof busy === "number") await this.#sleep(live, busy);
      } catch (cause) {
        if (live.gone) return;
        live.failures++;
        live.error = plainDictationError(cause);
        this.#publish();
        await this.#sleep(live, backoff(live.failures));
      }
    }
  }

  /** One unit of work; returns how long to rest before the next ("idle": until woken). */
  async #step(live: Live): Promise<"again" | "idle" | number> {
    const record = live.record;
    if (record.state === "sent") {
      await this.#forget(live);
      return "again";
    }
    if (!record.registered) {
      if (record.state === "paused" && record.sizes.length === 0) return "idle";
      try {
        this.#accept(
          live,
          await this.#request(live, {
            action: "start",
            id: record.serverId,
            project: record.project,
          }),
        );
      } catch (cause) {
        // Taken by someone else, or the speech service cannot make this id
        // again: a new id is always free.
        if (statusOf(cause) === 409 || statusOf(cause) === 400) {
          await this.#continueElsewhere(live);
          return "again";
        }
        throw cause;
      }
      this.#update(live, { registered: true });
      await this.#save(live);
      return "again";
    }
    if (record.uploaded < record.sizes.length) {
      await this.#uploadNext(live);
      return "again";
    }
    switch (record.state) {
      case "recording": {
        // Appends refresh the transcript; between them, ask.
        const since = this.#now() - live.heard;
        if (since < 1500) return 1500 - since;
        this.#accept(live, await this.#request(live, { action: "status", id: record.serverId }));
        return 1500;
      }
      case "paused":
        if (!this.#watched.has(record.id)) return "idle";
        this.#accept(live, await this.#request(live, { action: "status", id: record.serverId }));
        return 3000;
      case "sending":
        return this.#followDelivery(live);
      case "edited":
        return this.#followEdit(live);
      default:
        return "idle";
    }
  }

  async #uploadNext(live: Live) {
    const record = live.record;
    const sequence = record.uploaded;
    const samples = await this.#chunk(live, sequence);
    let state: DictationState;
    try {
      state = await this.#request(live, {
        action: "append",
        id: record.serverId,
        sequence,
        audio: encode(samples),
      });
    } catch (cause) {
      const status = statusOf(cause);
      if (status === 404) return this.#continueElsewhere(live);
      if (status === 409) return this.#resync(live);
      throw cause;
    }
    if (live.record.serverId !== record.serverId) return;
    if (!live.unsaved.has(sequence)) live.cache.delete(sequence);
    this.#accept(live, state);
    this.#update(live, { uploaded: sequence + 1 });
    await this.#save(live);
  }

  /** The server holds a different amount of audio than we think, or closed the recording. */
  async #resync(live: Live) {
    const { record } = live;
    let state: DictationState;
    try {
      state = await this.#request(live, { action: "status", id: record.serverId });
    } catch (cause) {
      if (statusOf(cause) !== 404) throw cause;
      return this.#continueElsewhere(live);
    }
    if (state.status !== "recording") return this.#continueElsewhere(live);
    let bytes = 0;
    let held = 0;
    while (held < record.sizes.length && bytes < state.bytes) bytes += record.sizes[held++]!;
    if (bytes !== state.bytes) return this.#continueElsewhere(live);
    this.#accept(live, state);
    this.#update(live, { uploaded: held });
    await this.#save(live);
  }

  async #followDelivery(live: Live): Promise<"again" | "idle" | number> {
    if (live.handoff) return "idle";
    const { record } = live;
    let state: DictationState;
    try {
      state = await this.#request(live, { action: "status", id: record.serverId });
    } catch (cause) {
      if (statusOf(cause) !== 404) throw cause;
      // The server knows neither the recording nor a delivery for it.
      this.#announceReturned(record.serverId);
      this.#update(live, {
        state: "paused",
        notice: "Not sent: the server lost track of this recording. Send it again or edit it.",
      });
      await this.#continueElsewhere(live);
      return "again";
    }
    this.#accept(live, state);
    if (!record.handedOff) {
      // The page closed while the chat was taking it. Did the server get it?
      if (state.delivery) this.#update(live, { handedOff: true });
      else
        this.#update(live, {
          state: "paused",
          notice:
            "Not sent: the page closed before the chat took this recording. Send it again or edit it.",
        });
      await this.#save(live);
      return "again";
    }
    if (state.delivery === "sent") {
      await this.#forget(live);
      return "again";
    }
    if (state.delivery === "empty") {
      this.#announceReturned(record.serverId);
      this.#update(live, {
        state: "paused",
        handedOff: false,
        notice:
          "Not sent: the speech service heard no speech. The audio is still saved on this device.",
      });
      // That server recording is closed; sending again starts a fresh one.
      await this.#continueElsewhere(live);
      return "again";
    }
    return 2000;
  }

  #announceReturned(serverId: string) {
    for (const listener of this.#returned) listener(serverId);
  }

  async #followEdit(live: Live): Promise<"again" | "idle" | number> {
    const { record } = live;
    if (!record.server || !SETTLED.has(record.server.status)) {
      const action = live.finishRequested ? "status" : "finish";
      this.#accept(live, await this.#request(live, { action, id: record.serverId }));
      live.finishRequested = true;
      await this.#save(live);
      return SETTLED.has(live.record.server?.status ?? "") ? "again" : 1000;
    }
    const text = record.server.final.trim() || record.server.draft.trim();
    const insert = this.#editors.get(record.target);
    if (!text) {
      this.#update(live, {
        state: "paused",
        notice: "The speech service heard no speech. The audio is still saved on this device.",
      });
      await this.#continueElsewhere(live);
      return "again";
    }
    if (insert?.(text)) {
      await this.#forget(live);
      return "again";
    }
    // No composer for this chat is open; the text goes in when one is.
    return "idle";
  }
}

export function wavFile(chunks: readonly Int16Array[]): Blob {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const buffer = new ArrayBuffer(44 + length);
  const view = new DataView(buffer);
  const tag = (offset: number, text: string) =>
    [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, length + 36, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, length, true);
  let offset = 44;
  for (const chunk of chunks) {
    new Uint8Array(buffer, offset, chunk.byteLength).set(
      new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    );
    offset += chunk.byteLength;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
