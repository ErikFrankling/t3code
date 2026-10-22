// @effect-diagnostics nodeBuiltinImport:off -- A throwaway HTTP server stands in for the speech service; ffmpeg makes the AAC.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { adtsFrames, submitRecording } from "./dictationAudio.ts";

const hasFfmpeg = NodeChildProcess.spawnSync("ffmpeg", ["-version"]).status === 0;

/** The speech service's recording protocol, as far as uploads use it. */
type Held = { sequence: number; bytes: number; status: string };
let held = new Map<string, Held>();
let failAppendAt: number | null = null;
let server: NodeHttp.Server;
let root = "";
let aac = Buffer.alloc(0);

beforeAll(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-dictation-test-"));
  if (hasFfmpeg) {
    const file = NodePath.join(root, "tone.aac");
    // Six seconds: about 94 AAC frames at 16 kHz.
    NodeChildProcess.execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "aac",
      "-b:a",
      "48k",
      "-f",
      "adts",
      file,
    ]);
    aac = await NodeFSP.readFile(file);
  }
  server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const data = JSON.parse(body) as {
        action: string;
        id: string;
        sequence?: number;
        audio?: string;
      };
      let state = held.get(data.id);
      const reply = () =>
        response.end(
          JSON.stringify({
            id: data.id,
            status: state!.status,
            draft: "",
            final: "",
            error: "",
            bytes: state!.bytes,
            sequence: state!.sequence,
          }),
        );
      if (data.action === "start") {
        state ??= { sequence: 0, bytes: 0, status: "recording" };
        held.set(data.id, state);
        return reply();
      }
      if (!state) return response.writeHead(404).end();
      if (data.action === "append") {
        if (failAppendAt !== null && state.sequence === failAppendAt) {
          failAppendAt = null;
          return response.writeHead(503).end("busy");
        }
        if (data.sequence !== state.sequence) return response.writeHead(409).end("sequence");
        state.sequence += 1;
        state.bytes += Buffer.from(data.audio!, "base64").byteLength;
        return reply();
      }
      if (data.action === "finish") state.status = "complete";
      return reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.T3CODE_STT_URL = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/dictation`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await NodeFSP.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  held = new Map();
  failAppendAt = null;
});

let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

/** Uploads `aac` in uneven pieces, as the phone does while the file grows. */
async function stream(directory: string, id: string, cuts: number[], final = true) {
  let offset = 0;
  for (const cut of [...cuts, aac.byteLength]) {
    const result = await submitRecording({
      directory,
      owner: "erik",
      id,
      project: "",
      audio: aac.subarray(offset, cut),
      offset,
      final: final && cut === aac.byteLength,
    });
    expect(result.kind).toBe("state");
    offset = cut;
  }
}

describe.skipIf(!hasFfmpeg)("submitRecording", () => {
  // Each AAC frame is 1024 samples, 2048 bytes of 16 kHz PCM.
  const expectedBytes = () => adtsFrames(aac).frames.length * 2048;

  it("passes every frame on once, whatever the upload boundaries", async () => {
    const directory = NodePath.join(root, "a");
    const id = newId();
    await stream(directory, id, [5, 700, 701, 4000, 9000]);
    expect(held.get(id)).toMatchObject({ status: "complete", bytes: expectedBytes() });
  });

  it("transcribes a recording cut off mid-frame (the phone lost power) up to its last whole frame", async () => {
    const directory = NodePath.join(root, "power-loss");
    const id = newId();
    const { frames } = adtsFrames(aac);
    // The file ends 100 bytes into a frame, as the phone left it when it died.
    const cut = aac.subarray(0, frames[frames.length - 3]! + 100);
    await submitRecording({
      directory,
      owner: "erik",
      id,
      project: "",
      audio: cut,
      offset: 0,
      final: true,
    });

    expect(adtsFrames(cut).frames).toHaveLength(frames.length - 3);
    expect(held.get(id)).toMatchObject({ status: "complete", bytes: (frames.length - 3) * 2048 });
  });

  it("keeps the audio on disk as received, before passing it on", async () => {
    const directory = NodePath.join(root, "b");
    const id = newId();
    await stream(directory, id, [3000], false);
    const kept = await NodeFSP.readFile(
      NodePath.join(directory, "dictation-uploads", id, "audio.aac"),
    );
    expect(kept.equals(aac)).toBe(true);
  });

  it("tells a client that skipped ahead where to continue", async () => {
    const directory = NodePath.join(root, "c");
    const id = newId();
    await submitRecording({
      directory,
      owner: "erik",
      id,
      project: "",
      audio: aac.subarray(0, 1000),
      offset: 0,
      final: false,
    });
    const gap = await submitRecording({
      directory,
      owner: "erik",
      id,
      project: "",
      audio: aac.subarray(2000, 3000),
      offset: 2000,
      final: false,
    });
    expect(gap).toEqual({ kind: "gap", expected: 1000 });
  });

  it("continues without duplicates after an upload failed halfway", async () => {
    const directory = NodePath.join(root, "d");
    const id = newId();
    failAppendAt = 2;
    await expect(
      submitRecording({
        directory,
        owner: "erik",
        id,
        project: "",
        audio: aac,
        offset: 0,
        final: false,
      }),
    ).rejects.toThrow();
    // The client sends the same range again.
    await submitRecording({
      directory,
      owner: "erik",
      id,
      project: "",
      audio: aac,
      offset: 0,
      final: true,
    });
    expect(held.get(id)).toMatchObject({ status: "complete", bytes: expectedBytes() });
  });

  it("continues from the speech service's count when the server lost its notes", async () => {
    const directory = NodePath.join(root, "e");
    const id = newId();
    await stream(directory, id, [4000], false);
    const before = held.get(id)!.bytes;
    // A restart that lost meta.json (the audio stays).
    await NodeFSP.rm(NodePath.join(directory, "dictation-uploads", id, "meta.json"));
    await NodeFSP.rm(NodePath.join(directory, "dictation-uploads", id, "audio.aac"));
    const gap = await submitRecording({
      directory,
      owner: "erik",
      id,
      project: "",
      audio: aac.subarray(9000),
      offset: 9000,
      final: false,
    });
    expect(gap).toEqual({ kind: "gap", expected: 0 });
    await submitRecording({
      directory,
      owner: "erik",
      id,
      project: "",
      audio: aac,
      offset: 0,
      final: true,
    });
    expect(before).toBeGreaterThan(0);
    expect(held.get(id)).toMatchObject({ status: "complete", bytes: expectedBytes() });
  });
});
