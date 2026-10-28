// @effect-diagnostics globalFetch:off nodeBuiltinImport:off -- Talks to a throwaway local HTTP server standing in for the speak daemon.
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readSpeakMode, writeSpeakMode } from "./speakMode.ts";

function fakeDaemon(initial: string) {
  let mode = initial;
  const requests: string[] = [];
  const server = Http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(`${request.method} ${request.url} ${body}`);
      if (request.method === "POST") mode = (JSON.parse(body) as { mode: string }).mode;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ mode, label: mode }));
    });
  });
  return new Promise<{ requests: string[]; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      process.env.T3CODE_SPEAK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ requests, close: () => server.close() });
    }),
  );
}

describe("speak mode", () => {
  afterEach(() => {
    delete process.env.T3CODE_SPEAK_URL;
  });

  it("reads and sets the mode the speak daemon keeps", async () => {
    const daemon = await fakeDaemon("voice-out");
    try {
      expect(await readSpeakMode()).toEqual({ mode: "voice-out" });
      expect(await writeSpeakMode("conversation")).toEqual({ mode: "conversation" });
      expect(await readSpeakMode()).toEqual({ mode: "conversation" });
      expect(daemon.requests[1]).toBe('POST /mode {"mode":"conversation","by":"t3"}');
    } finally {
      daemon.close();
    }
  });

  it("is null where no speak daemon runs, and for a mode it does not know", async () => {
    process.env.T3CODE_SPEAK_URL = "http://127.0.0.1:1";
    expect(await readSpeakMode(300)).toBeNull();
    expect(await writeSpeakMode("silent", 300)).toBeNull();
    const daemon = await fakeDaemon("loud");
    try {
      expect(await readSpeakMode()).toBeNull();
    } finally {
      daemon.close();
    }
  });
});
