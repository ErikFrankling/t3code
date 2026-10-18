// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Same plain Node calls to the local speech server as DictationDelivery.ts, plus one ffmpeg run.
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

/**
 * A whole recording in one request, for clients that cannot stream PCM (the
 * Android app records a compressed file). Registers it with the speech service,
 * uploads it as ordinary chunks and asks for the final transcript; the client
 * polls `status` until it is complete.
 */
export async function submitRecording(input: {
  readonly owner: string;
  readonly id: string;
  readonly project: string;
  readonly audio: Uint8Array;
}): Promise<DictationState> {
  const pcm = await decodeToPcm(input.audio);
  if (pcm.byteLength === 0) throw new Error("The recording contains no audio.");
  await speech(input.owner, { action: "start", id: input.id, project: input.project });
  for (let offset = 0, sequence = 0; offset < pcm.byteLength; offset += CHUNK_BYTES, sequence++) {
    await speech(input.owner, {
      action: "append",
      id: input.id,
      sequence,
      audio: pcm.subarray(offset, offset + CHUNK_BYTES).toString("base64"),
    });
  }
  return speech(input.owner, { action: "finish", id: input.id });
}
