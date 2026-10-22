import { fetch } from "expo/fetch";
import { File, FileMode } from "expo-file-system";

import { DictationState } from "@t3tools/contracts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import * as Schema from "effect/Schema";

import {
  setDictationPreview,
  updateDictationPreview,
} from "../features/voice-input/dictationPreview";
import { uuidv4 } from "../lib/uuid";
import { dropUndeliveredDictation, undeliveredReason } from "../state/acknowledged-thread-messages";
import type { ResolveDictationConnection, VoiceDictationTarget } from "./voiceTranscription";

export type {
  DictatedMessage,
  ResolveDictationConnection,
  VoiceDictationTarget,
} from "./voiceTranscription";

const decodeDictationState = Schema.decodeUnknownSync(DictationState);
const UPLOAD_INTERVAL_MS = 1_000;
const POLL_INTERVAL_MS = 800;
// The final recogniser waits out GPU contention and restarts on the PC.
const FINAL_TIMEOUT_MS = 30 * 60_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const done = (state: DictationState) =>
  state.status !== "recording" && state.status !== "finalizing";

/**
 * Android has no on-device recogniser here. The recording (AAC in ADTS, which
 * can be read while it grows) is uploaded to the environment's own speech
 * service every second, the same one the web composer's microphone uses, so
 * its live draft and refined text show while you talk. On stop the rest is
 * uploaded and the composer queues the message with `[dictation:<id>]`; the
 * server sends it once the final transcript exists, as on the web.
 */
class DictationStream {
  readonly id = uuidv4().toLowerCase();
  private uri: string | null = null;
  private offset = 0;
  private stopped = false;
  private inflight: Promise<void> = Promise.resolve();
  /** Set while the preview keeps following a message the server now owns. */
  following = false;

  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string>,
    readonly target: VoiceDictationTarget,
  ) {}

  begin(uri: string | null, ownerKey: string | null): void {
    if (!uri || this.uri) return;
    this.uri = uri;
    setDictationPreview({ ownerKey, phase: "listening", draft: "", final: "" });
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.inflight = this.upload(false).then(
        () => {},
        () => {
          // The audio stays in the file; the next upload sends it.
        },
      );
      await this.inflight;
      await wait(UPLOAD_INTERVAL_MS);
    }
  }

  private async upload(final: boolean): Promise<DictationState | null> {
    if (!this.uri) return null;
    const handle = new File(this.uri).open(FileMode.ReadOnly);
    let audio: Uint8Array<ArrayBuffer>;
    try {
      handle.offset = this.offset;
      audio = await handle.readBytes(Math.max(0, (handle.size ?? 0) - this.offset));
    } finally {
      handle.close();
    }
    if (!final && audio.byteLength === 0) return null;
    const url = new URL("/api/dictation/audio", this.baseUrl);
    url.searchParams.set("id", this.id);
    url.searchParams.set("project", this.target.project);
    url.searchParams.set("offset", String(this.offset));
    url.searchParams.set("final", final ? "1" : "0");
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/octet-stream" },
      body: audio,
    });
    if (response.status === 409) {
      // The server holds a different amount than we think; resend from there.
      const { expected } = (await response.json()) as { expected: number };
      this.offset = expected;
      return this.upload(final);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    this.offset += audio.byteLength;
    const state = decodeDictationState(await response.json());
    if (!this.stopped) updateDictationPreview({ draft: state.draft, final: state.final });
    return state;
  }

  private async status(): Promise<DictationState> {
    const response = await fetch(new URL("/api/dictation", this.baseUrl).toString(), {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", id: this.id }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return decodeDictationState(await response.json());
  }

  /** Uploads the rest of the recording and asks for the final transcript. */
  private async close(uri: string, signal: AbortSignal): Promise<DictationState> {
    this.stopped = true;
    this.uri ??= uri;
    await this.inflight;
    for (let attempt = 0; ; attempt++) {
      throwIfVoiceTranscriptionAborted(signal);
      try {
        const state = await this.upload(true);
        if (state) return state;
      } catch (error) {
        // A retried request (or a lost response) can find the recording already
        // finished; then the first one worked.
        const state = await this.status().catch(() => null);
        if (state && state.status !== "recording" && state.status !== "cancelled") return state;
        if (attempt >= 4) throw error;
      }
      await wait(1_000 * (attempt + 1));
    }
  }

  private async poll(state: DictationState, signal?: AbortSignal): Promise<DictationState> {
    const deadline = Date.now() + FINAL_TIMEOUT_MS;
    while (!done(state)) {
      updateDictationPreview({ draft: state.draft, final: state.final });
      if (signal) throwIfVoiceTranscriptionAborted(signal);
      if (Date.now() > deadline) throw new Error("The speech service took too long.");
      await wait(POLL_INTERVAL_MS);
      state = await this.status().catch(() => state);
    }
    updateDictationPreview({ draft: state.draft, final: state.final });
    return state;
  }

  private static text(state: DictationState): string {
    if (state.status !== "complete") throw new Error(state.error || `Dictation ${state.status}.`);
    return (state.final || state.draft).trim();
  }

  async transcribe(uri: string, signal: AbortSignal): Promise<string> {
    updateDictationPreview({ phase: "refining" });
    return DictationStream.text(await this.poll(await this.close(uri, signal), signal));
  }

  async deliver(uri: string, signal: AbortSignal): Promise<string | null> {
    const send = this.target.send;
    if (!send) return this.transcribe(uri, signal);
    updateDictationPreview({ phase: "refining" });
    const state = await this.close(uri, signal);
    if (!(await send({ id: this.id, draft: state.draft }))) {
      // The composer refused the message; keep the words in the draft instead.
      return DictationStream.text(await this.poll(state, signal));
    }
    // The server owns the message now: the panel closes (the chat shows the
    // message, live text first, until its transcript is final) and the outcome
    // is followed in the background.
    this.following = true;
    setDictationPreview(null);
    void this.settle(state);
    return null;
  }

  /**
   * Follows a sent dictation until the server posted it. One it will never
   * post (no speech was recognized, or it gave up) would otherwise leave a
   * "Transcribing…" row in the chat for good: that row goes, and the chat says
   * why. The recording stays on the server either way.
   */
  private async settle(state: DictationState): Promise<void> {
    const deadline = Date.now() + FINAL_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        if (state.delivery === "sent") return;
        if (state.delivery === "empty" || state.delivery === "abandoned") {
          dropUndeliveredDictation(this.id, undeliveredReason(state));
          return;
        }
        await wait(POLL_INTERVAL_MS);
        state = await this.status().catch(() => state);
      }
    } finally {
      if (active === this) active = null;
    }
  }

  cancel(): void {
    this.stopped = true;
    void this.inflight
      .then(() =>
        fetch(new URL("/api/dictation", this.baseUrl).toString(), {
          method: "POST",
          headers: { ...this.headers, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel", id: this.id }),
        }),
      )
      .catch(() => {});
  }
}

let active: DictationStream | null = null;
let finishing = false;

/** Called when recording starts, with the file the recorder writes. */
export function beginDictationStream(uri: string | null, ownerKey: string | null): void {
  active?.begin(uri, ownerKey);
}

/** Called when voice input goes idle or fails: drops an unfinished recording. */
export function endDictationStream(): void {
  if (!active || active.following) return;
  if (!finishing) active.cancel();
  active = null;
  finishing = false;
  setDictationPreview(null);
}

export function getLocalVoiceTranscriber(
  resolveConnection?: ResolveDictationConnection,
): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      const resolved = resolveConnection?.() ?? null;
      const authorization = resolved?.connection.httpAuthorization ?? null;
      if (!resolved || authorization?._tag === "Dpop") {
        throw new VoiceTranscriptionError(
          "unavailable",
          "Dictation needs a direct connection to your computer.",
        );
      }
      const stream = new DictationStream(
        resolved.connection.httpBaseUrl,
        authorization ? { Authorization: `Bearer ${authorization.token}` } : {},
        resolved.target,
      );
      if (active && !active.following) active.cancel();
      active = stream;
      finishing = false;
      const run = async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
        if (active === stream) finishing = true;
        try {
          return await work();
        } catch (error) {
          if (signal.aborted) {
            stream.cancel();
            throwIfVoiceTranscriptionAborted(signal);
          }
          if (error instanceof VoiceTranscriptionError) throw error;
          throw new VoiceTranscriptionError("transcription-failed", "Dictation failed.", {
            cause: error,
          });
        }
      };
      return {
        locale: "auto",
        transcribe: (uri, { signal }) => run(signal, () => stream.transcribe(uri, signal)),
        deliver: (uri, { signal }) => run(signal, () => stream.deliver(uri, signal)),
      } satisfies PreparedVoiceTranscription;
    },
  };
}
