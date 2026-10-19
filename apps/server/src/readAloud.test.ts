// @effect-diagnostics nodeBuiltinImport:off -- A throwaway HTTP server stands in for llama-swap and the TTS servers.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { polishClip, readAloud, readWav, takeSentences, whenSettled } from "./readAloud.ts";

type Speech = { voice: string; input: string; speed: number; model: string };

function rawWav(samples: Int16Array, sampleRate = 24000) {
  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

let server: NodeHttp.Server;
let base = "";
let bigLoaded = false;
let bigFails = false;
let summary = "";
let spoken: Speech[] = [];

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url === "/running") {
        response.end(
          JSON.stringify({ running: bigLoaded ? [{ model: "higgs-tts", state: "ready" }] : [] }),
        );
        return;
      }
      if (request.url === "/chat") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        // Token-sized pieces, so sentences arrive split across chunks.
        for (const piece of summary.match(/.{1,7}/gs) ?? []) {
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
        return;
      }
      const speech = JSON.parse(body) as Speech;
      if (request.url === "/big" && bigFails) {
        response.writeHead(502).end();
        return;
      }
      spoken.push(speech);
      const sampleRate = 24000;
      const pad = sampleRate / 5;
      const speechSamples = (sampleRate / 100) * speech.input.length;
      const samples = new Int16Array(pad + speechSamples + pad);
      for (let i = 0; i < speechSamples; i++) samples[pad + i] = i % 2 ? 3000 : -3000;
      response.end(rawWav(samples, sampleRate));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  process.env.T3CODE_READ_ALOUD_LLM_URL = `${base}/chat`;
  process.env.T3CODE_READ_ALOUD_RUNNING_URL = `${base}/running`;
  process.env.T3CODE_READ_ALOUD_BIG_TTS_URL = `${base}/big`;
  process.env.T3CODE_READ_ALOUD_SMALL_TTS_URL = `${base}/small`;
  process.env.T3CODE_READ_ALOUD_SMALL_SPEED = "1.2";
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  bigLoaded = false;
  bigFails = false;
  spoken = [];
});

async function finished(text: string, options: Parameters<typeof readAloud>[0] = {}) {
  const started = readAloud({ text, ...options });
  if (!started) throw new Error("no job");
  await whenSettled(started.id);
  const state = readAloud({ id: started.id });
  if (!state) throw new Error("job vanished");
  return state;
}

describe("takeSentences", () => {
  it("keeps the unfinished sentence for later", () => {
    expect(takeSentences("Ok so. It fits. And then", false)).toEqual({
      sentences: ["Ok so.", "It fits."],
      rest: " And then",
    });
  });

  it("cuts a run-on sentence at a comma", () => {
    const long = `${"word ".repeat(40)}, ${"more ".repeat(40)}.`;
    const { sentences } = takeSentences(long, true);
    expect(sentences.length).toBe(2);
    expect(sentences.every((sentence) => sentence.length <= 260)).toBe(true);
  });
});

describe("readAloud", () => {
  it("speaks the first sentence alone, then the rest in one chunk, with the small voice", async () => {
    summary = "Ok so, the model fits. Dictation stays loaded. Want me to build it?";
    const state = await finished("A long assistant message.", { speed: 1.5 });
    expect(state.status).toBe("complete");
    expect(state.voice).toBe("small");
    expect(state.sentences.map((sentence) => sentence.text)).toEqual([
      "Ok so, the model fits.",
      "Dictation stays loaded.",
      "Want me to build it?",
    ]);
    expect(spoken.map((speech) => speech.input)).toEqual([
      "Ok so, the model fits.",
      "Dictation stays loaded. Want me to build it?",
    ]);
    expect(state.sentences.map((sentence) => sentence.span)).toEqual([1, 2, undefined]);
    expect(state.sentences.every((sentence) => sentence.ready)).toBe(true);
    // The request's speed multiplies the voice's own pace.
    expect(spoken[0]?.speed).toBeCloseTo(1.8);
  });

  it("uses the big voice only while llama-swap has it loaded", async () => {
    bigLoaded = true;
    summary = "Higgs is warm. It speaks.";
    const state = await finished("Another message.");
    expect(state.voice).toBe("big");
    expect(spoken.map((speech) => speech.voice)).toEqual(["erik", "erik"].slice(0, spoken.length));
    expect(spoken[0]?.voice).toBe("erik");
  });

  it("finishes on the small voice when the big one is taken away", async () => {
    bigLoaded = true;
    bigFails = true;
    summary = "Dictation came back. Kokoro takes over.";
    const state = await finished("Third message.");
    expect(state.status).toBe("complete");
    expect(state.voice).toBe("small");
    expect(state.sentences.every((sentence) => sentence.ready)).toBe(true);
  });

  it("reads the full message without markdown or code blocks", async () => {
    const state = await finished(
      "# Plan\n\n- **First** step.\n\n```ts\nconst x = 1;\n```\n\nDone.",
      {
        mode: "full",
      },
    );
    expect(state.sentences.map((sentence) => sentence.text)).toEqual([
      "Plan.",
      "First step.",
      "Done.",
    ]);
  });

  it("returns only the audio the client does not have yet", async () => {
    summary = "One. Two. Three.";
    const state = await finished("Fourth message.");
    // Chunks: "One." alone, then "Two. Three."; a client holding the first asks from 1.
    const polled = readAloud({ id: state.id, from: 1 });
    expect(polled?.sentences.map((sentence) => sentence.audio !== undefined)).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe("polishClip", () => {
  it("trims the voice's padding and ends every clip with the same short pause", () => {
    const sampleRate = 24000;
    const samples = new Int16Array(sampleRate);
    for (let i = 6000; i < 18000; i++) samples[i] = i % 2 ? 5000 : -5000;
    const clip = readWav(polishClip({ sampleRate, samples }));
    // 0.5 s of speech, 30 ms kept on each side, 280 ms pause.
    expect(clip.samples.length / sampleRate).toBeCloseTo(0.5 + 0.06 + 0.28, 2);
    expect(clip.samples[0]).toBe(0);
    expect(clip.samples.at(-1)).toBe(0);
  });
});
