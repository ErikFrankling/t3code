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

import { setDictationPreview } from "../features/voice-input/dictationPreview";
import { uuidv4 } from "../lib/uuid";
import type { ResolveDictationConnection } from "./voiceTranscription";

export type { ResolveDictationConnection, VoiceDictationTarget } from "./voiceTranscription";

const decodeDictationState = Schema.decodeUnknownSync(DictationState);
const UPLOAD_INTERVAL_MS = 1_000;
const POLL_INTERVAL_MS = 800;
// The final recogniser waits out GPU contention and restarts on the PC.
const FINAL_TIMEOUT_MS = 10 * 60_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Android has no on-device recogniser here. The recording (AAC in ADTS, which
 * can be read while it grows) is uploaded to the environment's own speech
 * service every second, the same one the web composer's microphone uses, so
 * its live draft shows while you talk. Stop asks for the final transcript.
 */
class DictationStream {
  readonly id = uuidv4().toLowerCase();
  private uri: string | null = null;
  private offset = 0;
  private stopped = false;
  private inflight: Promise<void> = Promise.resolve();

  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string>,
    private readonly project: string,
  ) {}

  begin(uri: string | null): void {
    if (!uri || this.uri) return;
    this.uri = uri;
    setDictationPreview({ phase: "listening", draft: "", final: "" });
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
    url.searchParams.set("project", this.project);
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
    if (!this.stopped) setDictationPreview({ phase: "listening", draft: state.draft, final: "" });
    return state;
  }

  private async call(body: Record<string, unknown>): Promise<DictationState> {
    const response = await fetch(new URL("/api/dictation", this.baseUrl).toString(), {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, id: this.id }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return decodeDictationState(await response.json());
  }

  async finish(uri: string, signal: AbortSignal): Promise<string> {
    this.stopped = true;
    this.uri ??= uri;
    await this.inflight;
    let state: DictationState | null = null;
    for (let attempt = 0; state === null; attempt++) {
      throwIfVoiceTranscriptionAborted(signal);
      try {
        state = await this.upload(true);
      } catch (error) {
        if (attempt >= 4) throw error;
        await wait(1_000 * (attempt + 1));
      }
    }
    const deadline = Date.now() + FINAL_TIMEOUT_MS;
    while (state.status === "recording" || state.status === "finalizing") {
      setDictationPreview({ phase: "refining", draft: state.draft, final: state.final });
      throwIfVoiceTranscriptionAborted(signal);
      if (Date.now() > deadline) throw new Error("The speech service took too long.");
      await wait(POLL_INTERVAL_MS);
      state = await this.call({ action: "status" }).catch(() => state!);
    }
    if (state.status !== "complete") throw new Error(state.error || `Dictation ${state.status}.`);
    return (state.final || state.draft).trim();
  }

  cancel(): void {
    this.stopped = true;
    void this.inflight.then(() => this.call({ action: "cancel" })).catch(() => {});
  }
}

let active: DictationStream | null = null;
let finishing = false;

/** Called when recording starts, with the file the recorder writes. */
export function beginDictationStream(uri: string | null): void {
  active?.begin(uri);
}

/** Called when voice input goes idle: drops the preview and any unfinished upload. */
export function endDictationStream(): void {
  if (active && !finishing) active.cancel();
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
        resolved.project,
      );
      active?.cancel();
      active = stream;
      finishing = false;
      return {
        locale: "auto",
        transcribe: async (uri, { signal }) => {
          if (active === stream) finishing = true;
          try {
            return await stream.finish(uri, signal);
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
        },
      } satisfies PreparedVoiceTranscription;
    },
  };
}
