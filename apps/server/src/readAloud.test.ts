// @effect-diagnostics nodeBuiltinImport:off -- A throwaway HTTP server stands in for llama-swap and the TTS servers.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { readAloud, takeSentences, whenSettled } from "./readAloud.ts";

type Speech = { voice: string; input: string; speed: number; model: string };

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
      response.end(Buffer.from(`${request.url}:${speech.input}`));
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

const decode = (audio: string | undefined) => Buffer.from(audio ?? "", "base64").toString();

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
  it("speaks the streamed summary sentence by sentence with the small voice", async () => {
    summary = "Ok so, the model fits. Dictation stays loaded. Want me to build it?";
    const state = await finished("A long assistant message.", { speed: 1.5 });
    expect(state.status).toBe("complete");
    expect(state.voice).toBe("small");
    expect(state.sentences.map((sentence) => sentence.text)).toEqual([
      "Ok so, the model fits.",
      "Dictation stays loaded.",
      "Want me to build it?",
    ]);
    expect(decode(state.sentences[2]?.audio)).toBe("/small:Want me to build it?");
    // The request's speed multiplies the voice's own pace.
    expect(spoken[0]?.speed).toBeCloseTo(1.8);
  });

  it("uses the big voice only while llama-swap has it loaded", async () => {
    bigLoaded = true;
    summary = "Higgs is warm. It speaks.";
    const state = await finished("Another message.");
    expect(state.voice).toBe("big");
    expect(spoken.map((speech) => speech.voice)).toEqual(["erik", "erik"]);
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
    const polled = readAloud({ id: state.id, from: 2 });
    expect(polled?.sentences.map((sentence) => sentence.audio !== undefined)).toEqual([
      false,
      false,
      true,
    ]);
  });
});
