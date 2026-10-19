// @effect-diagnostics globalTimers:off -- Plain promises, like readAloud.test.ts.
import { describe, expect, it } from "vite-plus/test";

import type { ReadAloudPlayer, ReadAloudSnapshot } from "./readAloud.ts";
import { VOICE_LOOP_CUE, VoiceLoop } from "./voiceLoop.ts";

/** Stands in for the read-aloud player: each start() plays until finish(). */
function fakePlayer() {
  const started: { key: string; text: string; mode: string }[] = [];
  const listeners = new Set<() => void>();
  let state = { phase: "idle", key: null } as unknown as ReadAloudSnapshot;
  const set = (patch: Partial<ReadAloudSnapshot>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const player = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: (key: string, text: string, mode = "summary") => {
      started.push({ key, text, mode });
      set({ key, phase: "loading" });
    },
    stop: () => set({ key: null, phase: "idle" }),
  } as unknown as ReadAloudPlayer;
  return { player, started, finish: () => set({ phase: "done" }), set };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const fake = fakePlayer();
  const calls: string[] = [];
  const loop = new VoiceLoop({
    player: fake.player,
    listen: () => void calls.push("listen"),
    send: () => void calls.push("send"),
  });
  return { ...fake, calls, loop };
}

describe("VoiceLoop", () => {
  it("says the cue, listens, sends, then reads only the finished reply", async () => {
    const { loop, started, finish, calls } = setup();
    loop.update({ reply: { key: "old", text: "Earlier." }, working: false });
    loop.start();
    expect(loop.getSnapshot().phase).toBe("cue");
    expect(started.at(-1)?.text).toBe(VOICE_LOOP_CUE);
    finish();
    await tick();
    expect(calls).toEqual(["listen"]);
    expect(loop.getSnapshot().phase).toBe("listening");

    loop.endTurn();
    await tick();
    expect(calls).toEqual(["listen", "send"]);
    expect(loop.getSnapshot().phase).toBe("waiting");

    // The old reply and a message mid-turn are not read.
    loop.update({ reply: { key: "old", text: "Earlier." }, working: true });
    loop.update({ reply: { key: "mid", text: "Looking into it." }, working: true });
    expect(loop.getSnapshot().phase).toBe("waiting");
    loop.update({ reply: { key: "new", text: "Done, it works." }, working: false });
    expect(loop.getSnapshot().phase).toBe("reading");
    expect(started.at(-1)).toEqual({ key: "new", text: "Done, it works.", mode: "summary" });

    finish();
    await tick();
    expect(loop.getSnapshot().phase).toBe("cue");
    finish();
    await tick();
    expect(calls).toEqual(["listen", "send", "listen"]);
  });

  it("lets the reply already being read finish before listening", async () => {
    const { loop, player, finish, calls } = setup();
    player.start("reply", "Hello.");
    loop.start();
    expect(loop.getSnapshot().phase).toBe("reading");
    finish();
    await tick();
    expect(loop.getSnapshot().phase).toBe("cue");
    finish();
    await tick();
    expect(calls).toEqual(["listen"]);
  });

  it("ends the reading early when the turn button is pressed", async () => {
    const { loop, player, finish, calls } = setup();
    player.start("reply", "A long answer.");
    loop.start();
    loop.endTurn();
    await tick();
    expect(loop.getSnapshot().phase).toBe("cue");
    finish();
    await tick();
    expect(calls).toEqual(["listen"]);
  });

  it("stops reading and listening when turned off", async () => {
    const { loop, player, finish, calls } = setup();
    loop.start();
    loop.stop();
    expect(player.getSnapshot().phase).toBe("idle");
    finish();
    await tick();
    expect(calls).toEqual([]);
    expect(loop.getSnapshot().phase).toBe("off");
  });

  it("turns off with the error when dictation cannot start", async () => {
    const fake = fakePlayer();
    const loop = new VoiceLoop({
      player: fake.player,
      listen: () => Promise.reject(new Error("No microphone.")),
      send: () => undefined,
    });
    loop.start();
    fake.finish();
    await tick();
    await tick();
    expect(loop.getSnapshot()).toEqual({ phase: "off", error: "No microphone." });
  });
});

describe("VoiceLoop waiting", () => {
  it("starts your turn again when a sent turn brings no reply", async () => {
    const { loop, finish, calls } = setup();
    loop.start();
    finish();
    await tick();
    loop.endTurn();
    await tick();
    expect(loop.getSnapshot().phase).toBe("waiting");
    loop.endTurn();
    expect(loop.getSnapshot().phase).toBe("cue");
    finish();
    await tick();
    expect(calls).toEqual(["listen", "send", "listen"]);
  });
});
