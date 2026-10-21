// @effect-diagnostics globalTimers:off -- Plain promise polling and playback, shared with React Native; no Effect runtime here.
import type { ReadAloudRequest, ReadAloudState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { ReadAloudPlayer, readAloudSpeed, type ReadAloudAudio } from "./readAloud.ts";

/** A job whose sentences and clips arrive over successive polls, like the server's. */
function fakeServer(steps: { text: string; audio?: string; span?: number; ready?: boolean }[][]) {
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
        ready: sentence.ready ?? sentence.audio !== undefined,
        ...(index >= from && sentence.audio
          ? { audio: sentence.audio, span: sentence.span ?? 1 }
          : {}),
      })),
    };
  };
  return { request, requests };
}

function fakeAudio() {
  const played: { clip: string; rate: number; next?: string; startFraction?: number }[] = [];
  const rates: number[] = [];
  let finish: (() => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  let progress: ((fraction: number) => void) | undefined;
  const audio: ReadAloudAudio = {
    play: (clip, options) => {
      played.push({
        clip: clip.audio,
        rate: options.rate,
        ...(options.next ? { next: options.next.audio } : {}),
        ...(options.startFraction ? { startFraction: options.startFraction } : {}),
      });
      progress = options.onProgress;
      return new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
    },
    setRate: (rate) => rates.push(rate),
    pause: () => undefined,
    resume: () => undefined,
    stop: () => fail?.(new Error("stopped")),
  };
  const endClip = async () => {
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { audio, played, rates, endClip, progress: (fraction: number) => progress?.(fraction) };
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
    // The clip that was playing sped up at once, not only the next one.
    expect(sound.rates).toEqual([1.5]);
  });

  it("synthesizes at most at twice the pace and plays faster speeds faster", async () => {
    const server = fakeServer([[{ text: "One.", audio: "a1" }]]);
    const sound = fakeAudio();
    const player = new ReadAloudPlayer({
      request: server.request,
      audio: sound.audio,
      pollMs: 0,
      speed: 3,
    });
    player.start("message-1", "text");
    await until(() => sound.played.length === 1);
    expect(server.requests[0]?.speed).toBe(2);
    expect(sound.played[0]?.rate).toBe(1.5);
    player.setSpeed(0.75);
    expect(sound.rates).toEqual([0.375]);
  });

  it("snaps a stored speed to one of the menu's choices", () => {
    expect(readAloudSpeed(1.3)).toBe(1.25);
    expect(readAloudSpeed(0.9)).toBe(1);
    expect(readAloudSpeed(9)).toBe(3);
    expect(readAloudSpeed("fast")).toBe(1);
    expect(readAloudSpeed(Number.NaN)).toBe(1);
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

  it("follows the subtitle through a chunk and preloads the next one", async () => {
    const server = fakeServer([
      [
        { text: "One.", audio: "c0" },
        { text: "Two is longer.", audio: "c1", span: 2 },
        { text: "Three.", ready: true },
        { text: "Four.", audio: "c3" },
      ],
    ]);
    const sound = fakeAudio();
    const player = new ReadAloudPlayer({ request: server.request, audio: sound.audio, pollMs: 0 });
    player.start("message-1", "text");
    await until(() => sound.played.length === 1);
    // The next chunk loads while the first plays, so there is no gap.
    expect(sound.played[0]).toMatchObject({ clip: "c0", next: "c1" });
    await sound.endClip();
    await until(() => sound.played.length === 2);
    expect(sound.played[1]).toMatchObject({ clip: "c1", next: "c3" });
    expect(player.getSnapshot().current).toBe(1);
    // "Two is longer." is most of the chunk's characters; past it, "Three." is spoken.
    sound.progress(0.5);
    expect(player.getSnapshot().current).toBe(1);
    sound.progress(0.8);
    expect(player.getSnapshot().current).toBe(2);
    await sound.endClip();
    await until(() => sound.played.length === 3);
    expect(sound.played[2]).toMatchObject({ clip: "c3" });
  });

  it("seeks into the middle of a chunk", async () => {
    const server = fakeServer([
      [
        { text: "One.", audio: "c0", span: 2 },
        { text: "Two.", ready: true },
      ],
    ]);
    const sound = fakeAudio();
    const player = new ReadAloudPlayer({ request: server.request, audio: sound.audio, pollMs: 0 });
    player.start("message-1", "text");
    await until(() => sound.played.length === 1);
    player.seek(1);
    await until(() => sound.played.length === 2);
    expect(sound.played[1]?.clip).toBe("c0");
    expect(sound.played[1]?.startFraction).toBeCloseTo(0.5);
  });
});
describe("ReadAloudPlayer preload", () => {
  it("preloads the next chunk the moment it arrives while the current one plays", async () => {
    let poll = 0;
    const preloaded: string[] = [];
    let finish: (() => void) | null = null;
    const player = new ReadAloudPlayer({
      pollMs: 1,
      audio: {
        play: () => new Promise<void>((resolve) => (finish = resolve)),
        pause: () => {},
        resume: () => {},
        stop: () => {},
        preload: (clip) => void preloaded.push(clip.audio),
      },
      request: async () => {
        poll++;
        // The first chunk arrives alone; the second only on a later poll.
        const second = poll >= 3;
        return {
          id: "job",
          status: second ? "complete" : "working",
          voice: "small",
          error: "",
          sentences: [
            { text: "One.", audio: "A", span: 1, ready: true },
            { text: "Two.", ...(second ? { audio: "B", span: 1 } : {}), ready: second },
          ],
        };
      },
    });
    player.start("key", "Text.");
    await vi.waitFor(() => expect(finish).not.toBeNull());
    await vi.waitFor(() => expect(preloaded).toEqual(["B"]));
    player.stop();
  });
});
