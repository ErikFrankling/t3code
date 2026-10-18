import { fetch } from "expo/fetch";
import { File } from "expo-file-system";

import { DictationState } from "@t3tools/contracts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";
import * as Schema from "effect/Schema";

import { uuidv4 } from "../lib/uuid";
import type { ResolveDictationConnection } from "./voiceTranscription";

export type { ResolveDictationConnection, VoiceDictationTarget } from "./voiceTranscription";

const decodeDictationState = Schema.decodeUnknownSync(DictationState);
const POLL_INTERVAL_MS = 1_000;
// The final recogniser waits out GPU contention and restarts on the PC.
const FINAL_TIMEOUT_MS = 10 * 60_000;

/**
 * Android has no on-device recogniser here. The recording goes to the
 * environment's own speech service (`/api/dictation/audio`, the same one the web
 * composer's microphone uses), which returns the final transcript.
 */
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
      const headers: Record<string, string> = authorization
        ? { Authorization: `Bearer ${authorization.token}` }
        : {};
      return {
        locale: "auto",
        transcribe: (uri, options) =>
          transcribe(uri, resolved.connection.httpBaseUrl, headers, resolved.project, options),
      } satisfies PreparedVoiceTranscription;
    },
  };
}

async function call(
  baseUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<DictationState> {
  const response = await fetch(new URL("/api/dictation", baseUrl).toString(), {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return decodeDictationState(await response.json());
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function transcribe(
  uri: string,
  baseUrl: string,
  headers: Record<string, string>,
  project: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  const id = uuidv4().toLowerCase();
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const audio = new Uint8Array(await new File(uri).arrayBuffer());
    throwIfVoiceTranscriptionAborted(signal);
    const url = new URL("/api/dictation/audio", baseUrl);
    url.searchParams.set("id", id);
    url.searchParams.set("project", project);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body: audio,
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    let state = decodeDictationState(await response.json());
    const deadline = Date.now() + FINAL_TIMEOUT_MS;
    while (state.status === "recording" || state.status === "finalizing") {
      throwIfVoiceTranscriptionAborted(signal);
      if (Date.now() > deadline) throw new Error("The speech service took too long.");
      await wait(POLL_INTERVAL_MS);
      state = await call(baseUrl, headers, { action: "status", id });
    }
    if (state.status !== "complete") throw new Error(state.error || `Dictation ${state.status}.`);
    return (state.final || state.draft).trim();
  } catch (error) {
    if (signal.aborted) {
      void call(baseUrl, headers, { action: "cancel", id }).catch(() => {});
      throwIfVoiceTranscriptionAborted(signal);
    }
    if (error instanceof VoiceTranscriptionError) throw error;
    throw new VoiceTranscriptionError("transcription-failed", "Dictation failed.", {
      cause: error,
    });
  }
}
