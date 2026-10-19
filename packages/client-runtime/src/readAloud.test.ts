// @effect-diagnostics globalTimers:off -- Plain promise polling and playback, shared with React Native; no Effect runtime here.
import type { ReadAloudRequest, ReadAloudState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ReadAloudPlayer, type ReadAloudAudio } from "./readAloud.ts";

/** A job whose sentences and clips arrive over successive polls, like the server's. */
function fakeServer(steps: { text: string; audio?: string }[][]) {
  let poll = 0;
  const requests: ReadAloudRequest[] = [];
  const request = async (body: ReadAloudRequest): Promise<ReadAloudState> => {
    requests.push(body);
    const step = steps[Math.min(poll++, steps.length - 1)] ?? [];
    const from = body.from ?? 0;
    return {
      id: "job",
      status: poll >= steps.length ? "complete" : "working",
      voice: "small",
      error: "",
      sentences: step.map((sentence, index) => ({
        text: sentence.text,
        ready: sentence.audio !== undefined,
        ...(index >= from && sentence.audio ? { audio: sentence.audio } : {}),
      })),
    };
  };
  return { request, requests };
}

function fakeAudio() {
  const played: { clip: string; rate: number }[] = [];
  let finish: (() => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const audio: ReadAloudAudio = {
    play: (clip, rate) => {
      played.push({ clip, rate });
      return new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    },
    pause: () => undefined,
    resume: () => undefined,
    stop: () => fail?.(new Error("stopped")),
  };
  const endClip = async () => {
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { audio, played, endClip };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
};

describe("ReadAloudPlayer", () => {
  it("plays sentences in order while the summary is still arriving", async () => {
    const server = fakeServer([
      [{ text: "One.", audio: "a1" }],
      [{ text: "One.", audio: "a1" }, { text: "Two." }],
      [
        { text: "One.", audio: "a1" },
        { text: "Two.", audio: "a2" },
      ],
    ]);
    const sound = fakeAudio();
    const player = new ReadAloudPlayer({ request: server.request, audio: sound.audio, pollMs: 0 });
    player.start("message-1", "Long message");
    await until(() => sound.played.length === 1);
    expect(player.getSnapshot()).toMatchObject({ phase: "playing", current: 0 });
    await sound.endClip();
    await until(() => sound.played.length === 2);
    expect(sound.played.map((entry) => entry.clip)).toEqual(["a1", "a2"]);
    await sound.endClip();
    await until(() => player.getSnapshot().phase === "done");
    expect(player.getSnapshot().sentences).toEqual(["One.", "Two."]);
    // Polls ask only for clips the player does not have yet.
    expect(server.requests.at(-1)?.from).toBe(1);
  });

  it("waits while paused instead of starting the next clip", async () => {
    const server = fakeServer([
      [
        { text: "One.", audio: "a1" },
        { text: "Two.", audio: "a2" },
      ],
    ]);
    const sound = fakeAudio();
    const player = new ReadAloudPlayer({ request: server.request, audio: sound.audio, pollMs: 0 });
    player.start("message-1", "text");
    await until(() => sound.played.length === 1);
    player.togglePause();
    await sound.endClip();
    expect(sound.played.length).toBe(1);
    player.togglePause();
    await until(() => sound.played.length === 2);
    expect(player.getSnapshot().phase).toBe("playing");
  });

  it("plays the current message faster when the speed changes", async () => {
    const server = fakeServer([
      [
        { text: "One.", audio: "a1" },
        { text: "Two.", audio: "a2" },
      ],
    ]);
    const sound = fakeAudio();
    const player = new ReadAloudPlayer({ request: server.request, audio: sound.audio, pollMs: 0 });
    player.start("message-1", "text");
    await until(() => sound.played.length === 1);
    expect(server.requests[0]?.speed).toBe(1);
    player.setSpeed(1.5);
    await sound.endClip();
    await until(() => sound.played.length === 2);
    expect(sound.played[1]?.rate).toBe(1.5);
  });

  it("forgets the old message when a new one starts", async () => {
    const server = fakeServer([[{ text: "Old.", audio: "old" }]]);
    const sound = fakeAudio();
    const player = new ReadAloudPlayer({ request: server.request, audio: sound.audio, pollMs: 0 });
    player.start("message-1", "old text");
    await until(() => sound.played.length === 1);
    player.stop();
    expect(player.getSnapshot()).toMatchObject({ phase: "idle", key: null, sentences: [] });
  });
});
