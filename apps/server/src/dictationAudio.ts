// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- Same plain Node calls to the local speech server as DictationDelivery.ts, plus ffmpeg runs.
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

/** One upload body; a whole recording sent at once may be this large. */
export const DICTATION_AUDIO_MAX_BYTES = 16 * 1024 * 1024;
/** Four hours of the phone's 48 kbit/s AAC, the speech service's own limit. */
const RECORDING_MAX_BYTES = 4 * 3600 * 6000 * 1.5;
// One second of 16 kHz 16-bit mono, well under the speech service's chunk cap.
const CHUNK_BYTES = 32000;
// Each AAC frame is 1024 samples; decoding resumes two frames back so the
// decoder's overlap is warmed up again, and those two frames are dropped.
const OVERLAP_FRAMES = 2;
const SAMPLES_PER_FRAME = 1024;

const ffmpegPath = () => process.env.T3CODE_FFMPEG ?? "ffmpeg";

/** Audio in any container ffmpeg reads (or raw ADTS with `format: "aac"`) to 16 kHz mono PCM. */
async function decodeToPcm(audio: Uint8Array, format?: "aac"): Promise<Buffer> {
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
        ...(format ? ["-f", format] : []),
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

type SpeechState = DictationState & { readonly sequence?: number };

async function speech(owner: string, body: Record<string, unknown>): Promise<SpeechState> {
  const response = await fetch(speechServiceUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-STT-Owner": owner },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Speech service returned HTTP ${response.status}: ${await response.text()}`);
  }
  const body2 = (await response.json()) as { sequence?: unknown };
  const state = decodeDictationState(body2);
  return typeof body2.sequence === "number" ? { ...state, sequence: body2.sequence } : state;
}

/** Complete ADTS frames in `data` from `start`: their byte offsets, and where the next one begins. */
export function adtsFrames(
  data: Uint8Array,
  start = 0,
): { frames: number[]; end: number; rate: number } {
  const frames: number[] = [];
  let rate = 16000;
  let offset = start;
  while (offset + 7 <= data.length) {
    if (data[offset] !== 0xff || (data[offset + 1]! & 0xf0) !== 0xf0) {
      throw new Error("The recording is not AAC in ADTS frames.");
    }
    const length =
      ((data[offset + 3]! & 3) << 11) | (data[offset + 4]! << 3) | (data[offset + 5]! >> 5);
    if (length < 7) throw new Error("The recording has a broken AAC frame.");
    if (offset + length > data.length) break;
    rate = ADTS_RATES[(data[offset + 2]! >> 2) & 0xf] ?? rate;
    frames.push(offset);
    offset += length;
  }
  return { frames, end: offset, rate };
}

const ADTS_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * What survives a restart of the server for one recording: the audio exactly
 * as received (`audio.aac`, appended before anything else happens) and how far
 * it has been passed on to the speech service (`meta.json`).
 */
type Meta = {
  owner: string;
  project: string;
  started: boolean;
  /** ADTS frames already decoded and sent on. */
  framesSent: number;
  /** Byte offset of frame `framesSent` in audio.aac. */
  frameOffset: number;
  finished: boolean;
};

export type RecordingUploadResult =
  | { readonly kind: "state"; readonly state: DictationState }
  | { readonly kind: "gap"; readonly expected: number };

const queues = new Map<string, Promise<unknown>>();

/**
 * Compressed audio from the Android app (AAC in ADTS frames, 16 kHz mono).
 * Uploads arrive in order as byte ranges of one growing file (`offset`). Each
 * one is appended to the copy on disk first, so nothing received is ever lost:
 * not to a crash, a restart, or a pause of hours (the next upload continues
 * where the last ended, and a client that lost track is told where with a
 * `gap`). New complete frames are then decoded and passed on to the speech
 * service, so its live draft works as in the web composer. `final` asks for
 * the final transcript. A single upload with offset 0 and `final` may also
 * send a whole recording in any container ffmpeg reads.
 */
export function submitRecording(input: {
  /** The server's state directory; uploads live in `dictation-uploads/<id>`. */
  readonly directory: string;
  readonly owner: string;
  readonly id: string;
  readonly project: string;
  readonly audio: Uint8Array;
  readonly offset: number;
  readonly final: boolean;
}): Promise<RecordingUploadResult> {
  const previous = queues.get(input.id) ?? Promise.resolve();
  const result = previous.then(() => receive(input));
  const settled = result.catch(() => undefined);
  queues.set(input.id, settled);
  void settled.then(() => {
    if (queues.get(input.id) === settled) queues.delete(input.id);
  });
  return result;
}

async function readMeta(file: string): Promise<Meta | null> {
  try {
    return JSON.parse(await NodeFSP.readFile(file, "utf8")) as Meta;
  } catch {
    return null;
  }
}

async function writeMeta(file: string, meta: Meta) {
  const temporary = `${file}.tmp`;
  await NodeFSP.writeFile(temporary, JSON.stringify(meta));
  await NodeFSP.rename(temporary, file);
}

async function receive(
  input: Parameters<typeof submitRecording>[0],
): Promise<RecordingUploadResult> {
  const folder = NodePath.join(input.directory, "dictation-uploads", input.id);
  await NodeFSP.mkdir(folder, { recursive: true, mode: 0o700 });
  const audioFile = NodePath.join(folder, "audio.aac");
  const metaFile = NodePath.join(folder, "meta.json");
  const meta: Meta = (await readMeta(metaFile)) ?? {
    owner: input.owner,
    project: input.project,
    started: false,
    framesSent: 0,
    frameOffset: 0,
    finished: false,
  };
  if (meta.owner !== input.owner) throw new Error("Recording identifier is already in use.");
  if (meta.finished) {
    return { kind: "state", state: await speech(input.owner, { action: "status", id: input.id }) };
  }

  // 1. Keep what arrived, before anything can fail.
  const size = await NodeFSP.stat(audioFile).then(
    (stat) => stat.size,
    () => 0,
  );
  if (input.offset > size) return { kind: "gap", expected: size };
  const fresh = input.audio.subarray(size - input.offset);
  if (size + fresh.byteLength > RECORDING_MAX_BYTES) throw new Error("The recording is too long.");
  if (fresh.byteLength > 0) {
    const handle = await NodeFSP.open(audioFile, "a", 0o600);
    try {
      await handle.write(fresh);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  const audio = await NodeFSP.readFile(audioFile);

  // 2. Pass it on to the speech service.
  if (!meta.started) {
    // Harmless for a recording the speech service already holds (this server lost its notes).
    await speech(input.owner, { action: "start", id: input.id, project: input.project });
    meta.started = true;
    await writeMeta(metaFile, meta);
  }
  const whole = input.offset === 0 && input.final && meta.framesSent === 0 && !isAdts(audio);
  const batch = whole
    ? { pcm: await decodeToPcm(audio), frames: 0, offset: 0, pcmStart: 0 }
    : await decodeNewFrames(audio, meta);
  const sent = await pass(input, batch);
  meta.framesSent += batch.frames;
  meta.frameOffset = batch.offset;
  await writeMeta(metaFile, meta);

  if (!input.final) {
    return { kind: "state", state: await speech(input.owner, { action: "status", id: input.id }) };
  }
  if (sent === 0) throw new Error("The recording contains no audio.");
  const state = await speech(input.owner, { action: "finish", id: input.id });
  meta.finished = true;
  await writeMeta(metaFile, meta);
  return { kind: "state", state };
}

const isAdts = (audio: Uint8Array) =>
  audio.length >= 2 && audio[0] === 0xff && (audio[1]! & 0xf0) === 0xf0;

type Batch = {
  readonly pcm: Buffer;
  readonly frames: number;
  readonly offset: number;
  /** Where `pcm` starts in the recording's PCM. */
  readonly pcmStart: number;
};

/** PCM of the complete frames not sent yet; `meta` moves past them once they are passed on. */
async function decodeNewFrames(audio: Buffer, meta: Meta): Promise<Batch> {
  const { frames, end, rate } = adtsFrames(audio, meta.frameOffset);
  const frameBytes = Math.round((SAMPLES_PER_FRAME * 16000) / rate) * 2;
  const pcmStart = meta.framesSent * frameBytes;
  if (frames.length === 0)
    return { pcm: Buffer.alloc(0), frames: 0, offset: meta.frameOffset, pcmStart };
  // Back up to warm the decoder; those frames' samples are dropped again.
  const back = Math.min(OVERLAP_FRAMES, meta.framesSent);
  const start = back > 0 ? adtsFrames(audio, 0).frames[meta.framesSent - back]! : meta.frameOffset;
  const decoded = await decodeToPcm(audio.subarray(start, end), "aac");
  const pcm = decoded.subarray(Math.min(back * frameBytes, decoded.length));
  return { pcm, frames: frames.length, offset: end, pcmStart };
}

/**
 * Appends a batch to the speech service. It holds `bytes` of PCM already and
 * expects `sequence` next; that may be more of this batch than this server
 * knows (an upload that failed halfway, a crash between its reply and our
 * notes, lost notes): what it has is skipped. Returns the PCM it then holds.
 */
async function pass(input: Parameters<typeof submitRecording>[0], batch: Batch): Promise<number> {
  const held = await speech(input.owner, { action: "status", id: input.id });
  let sequence = held.sequence ?? 0;
  let bytes = held.bytes;
  for (
    let offset = Math.max(0, bytes - batch.pcmStart);
    offset < batch.pcm.byteLength;
    offset += CHUNK_BYTES
  ) {
    const chunk = batch.pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, batch.pcm.byteLength));
    await speech(input.owner, {
      action: "append",
      id: input.id,
      sequence,
      audio: chunk.toString("base64"),
    });
    sequence += 1;
    bytes += chunk.byteLength;
  }
  return bytes;
}
