// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- Same plain Node calls to the local speech server as DictationDelivery.ts, plus one ffmpeg run.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { DictationState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { speechServiceUrl } from "./DictationDelivery.ts";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeDictationState = Schema.decodeUnknownSync(DictationState);

/** Five minutes of the phone's 128 kbit/s AAC, with room to spare. */
export const DICTATION_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
// One second of 16 kHz 16-bit mono, well under the speech service's chunk cap.
const CHUNK_BYTES = 32000;

const ffmpegPath = () => process.env.T3CODE_FFMPEG ?? "ffmpeg";

/** Any container ffmpeg reads (the phone records AAC in MPEG-4) to 16 kHz mono PCM. */
async function decodeToPcm(audio: Uint8Array): Promise<Buffer> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dictation-"));
  try {
    const input = NodePath.join(directory, "input");
    const output = NodePath.join(directory, "output.pcm");
    await NodeFSP.writeFile(input, audio);
    await run(
      ffmpegPath(),
      [
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        input,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        output,
      ],
      { timeout: 120_000 },
    );
    return await NodeFSP.readFile(output);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

async function speech(owner: string, body: Record<string, unknown>): Promise<DictationState> {
  const response = await fetch(speechServiceUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-STT-Owner": owner },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Speech service returned HTTP ${response.status}: ${await response.text()}`);
  }
  return decodeDictationState(await response.json());
}

// Decoding the whole stream again on every upload keeps the PCM prefix
// identical between uploads; the tail is held back because the last AAC frame
// may still be incomplete.
const HOLD_BACK_BYTES = 8000;
const ABANDONED_AFTER_MS = 30 * 60_000;

type Upload = {
  readonly owner: string;
  started: boolean;
  bytes: Buffer;
  pcmSent: number;
  sequence: number;
  touched: number;
  queue: Promise<unknown>;
};

const uploads = new Map<string, Upload>();
// Finished recordings by owner, so a retried final upload (clients and HTTP
// stacks resend after a lost response) gets the state instead of an error.
const finished = new Map<string, { readonly owner: string; readonly at: number }>();

export type RecordingUploadResult =
  | { readonly kind: "state"; readonly state: DictationState }
  | { readonly kind: "gap"; readonly expected: number };

/**
 * Compressed audio for clients that cannot stream PCM (the Android app records
 * AAC). Uploads arrive in order as byte ranges of one growing file (`offset`),
 * so the speech service sees the recording while it is made and its live draft
 * works as in the web composer; `final` asks for the final transcript, which the
 * client then polls with `status`. A single upload with offset 0 and `final`
 * sends a whole recording, in any container ffmpeg reads.
 */
export function submitRecording(input: {
  readonly owner: string;
  readonly id: string;
  readonly project: string;
  readonly audio: Uint8Array;
  readonly offset: number;
  readonly final: boolean;
}): Promise<RecordingUploadResult> {
  const now = Date.now();
  for (const [id, upload] of uploads) {
    if (now - upload.touched > ABANDONED_AFTER_MS) uploads.delete(id);
  }
  for (const [id, entry] of finished) {
    if (now - entry.at > ABANDONED_AFTER_MS) finished.delete(id);
  }
  const done = finished.get(input.id);
  if (done && done.owner === input.owner) {
    return speech(input.owner, { action: "status", id: input.id }).then((state) => ({
      kind: "state" as const,
      state,
    }));
  }
  const existing = uploads.get(input.id);
  if (existing && existing.owner !== input.owner) {
    return Promise.reject(new Error("Recording identifier is already in use."));
  }
  const upload: Upload = existing ?? {
    owner: input.owner,
    started: false,
    bytes: Buffer.alloc(0),
    pcmSent: 0,
    sequence: 0,
    touched: now,
    queue: Promise.resolve(),
  };
  uploads.set(input.id, upload);
  const result = upload.queue.then(() => receive(upload, input));
  upload.queue = result.catch(() => undefined);
  return result;
}

async function receive(
  upload: Upload,
  input: Parameters<typeof submitRecording>[0],
): Promise<RecordingUploadResult> {
  upload.touched = Date.now();
  if (input.offset > upload.bytes.byteLength) {
    return { kind: "gap", expected: upload.bytes.byteLength };
  }
  if (!upload.started) {
    await speech(input.owner, { action: "start", id: input.id, project: input.project });
    upload.started = true;
  }
  const fresh = input.audio.subarray(upload.bytes.byteLength - input.offset);
  if (fresh.byteLength > 0) upload.bytes = Buffer.concat([upload.bytes, fresh]);

  let pcm: Buffer | null = null;
  try {
    pcm = await decodeToPcm(upload.bytes);
  } catch (cause) {
    // Too little audio for a whole frame yet; the next upload decodes it.
    if (input.final) throw cause;
  }
  if (pcm) {
    const end = input.final
      ? pcm.byteLength
      : Math.max(upload.pcmSent, (pcm.byteLength - HOLD_BACK_BYTES) & ~1);
    for (let offset = upload.pcmSent; offset < end; offset += CHUNK_BYTES) {
      await speech(input.owner, {
        action: "append",
        id: input.id,
        sequence: upload.sequence++,
        audio: pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, end)).toString("base64"),
      });
    }
    upload.pcmSent = end;
  }
  if (!input.final) {
    return { kind: "state", state: await speech(input.owner, { action: "status", id: input.id }) };
  }
  if (upload.pcmSent === 0) throw new Error("The recording contains no audio.");
  const state = await speech(input.owner, { action: "finish", id: input.id });
  uploads.delete(input.id);
  finished.set(input.id, { owner: input.owner, at: Date.now() });
  return { kind: "state", state };
}
