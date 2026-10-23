// @effect-diagnostics globalTimers:off -- Plain promises, like readAloud.test.ts.
import { describe, expect, it } from "vite-plus/test";

import type { ReadAloudPlayer, ReadAloudSnapshot, ReadAloudTake } from "./readAloud.ts";
import { VOICE_LOOP_CUE, VoiceLoop, type VoiceLoopSpan } from "./voiceLoop.ts";

/**
 * Stands in for the read-aloud player: each start() plays until finish(). A
 * message that played to the end can be taken and replayed (kept audio).
 */
function fakePlayer() {
  const started: { key: string; text: string; mode: string }[] = [];
  const replayed: string[] = [];
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
    take: () =>
      state.key && state.phase === "done" ? ({ key: state.key } as ReadAloudTake) : null,
    replay: (take: ReadAloudTake) => {
      replayed.push(take.key);
      set({ key: take.key, phase: "loading" });
    },
  } as unknown as ReadAloudPlayer;
  return { player, started, replayed, finish: () => set({ phase: "done" }), set };
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

describe("VoiceLoop replay (volume up)", () => {
  /** A loop that read the reply "r1" to the end and is now saying the cue. */
  async function afterReply() {
    const harness = setup();
    harness.loop.update({ reply: null, working: false });
    harness.loop.start();
    harness.finish();
    await tick();
    harness.loop.endTurn();
    await tick();
    harness.loop.update({ reply: { key: "r1", text: "It works." }, working: false });
    harness.finish();
    await tick();
    expect(harness.loop.getSnapshot().phase).toBe("cue");
    return harness;
  }

  it("plays the last reply again from the phone's kept audio, then listens", async () => {
    const { loop, started, replayed, finish, calls } = await afterReply();
    const requested = started.length;
    loop.replay();
    expect(loop.getSnapshot().phase).toBe("reading");
    expect(replayed).toEqual(["r1"]);
    // No new summary is asked for.
    expect(started).toHaveLength(requested);
    finish();
    await tick();
    expect(loop.getSnapshot().phase).toBe("cue");
    finish();
    await tick();
    expect(calls.at(-1)).toBe("listen");
    expect(loop.getSnapshot().phase).toBe("listening");
  });

  it("restarts the reply while it is being read", async () => {
    const { loop, replayed, finish } = await afterReply();
    loop.replay();
    loop.replay();
    expect(replayed).toEqual(["r1", "r1"]);
    finish();
    await tick();
    expect(loop.getSnapshot().phase).toBe("cue");
  });

  it("does nothing while you talk, so a press never costs your words", async () => {
    const { loop, replayed, finish, calls } = await afterReply();
    finish();
    await tick();
    expect(loop.getSnapshot().phase).toBe("listening");
    loop.replay();
    expect(loop.getSnapshot().phase).toBe("listening");
    expect(replayed).toEqual([]);
    expect(calls.filter((call) => call === "send")).toHaveLength(1);
  });

  it("while waiting, replays and then reads the answer that came meanwhile", async () => {
    const { loop, replayed, started, finish } = await afterReply();
    finish();
    await tick();
    loop.endTurn();
    await tick();
    expect(loop.getSnapshot().phase).toBe("waiting");
    loop.replay();
    expect(replayed).toEqual(["r1"]);
    loop.update({ reply: { key: "r2", text: "Next answer." }, working: false });
    expect(loop.getSnapshot().phase).toBe("reading");
    finish();
    await tick();
    expect(started.at(-1)).toEqual({ key: "r2", text: "Next answer.", mode: "summary" });
    expect(loop.getSnapshot().phase).toBe("reading");
  });

  it("keeps a reply only until the next one", async () => {
    const { loop, replayed, started, finish } = await afterReply();
    finish();
    await tick();
    loop.endTurn();
    await tick();
    loop.update({ reply: { key: "r2", text: "Next answer." }, working: false });
    // Skipped before it finished: nothing kept for r2 yet, so it is asked for again.
    loop.endTurn();
    await tick();
    loop.replay();
    expect(replayed).toEqual([]);
    expect(started.at(-1)).toEqual({ key: "r2", text: "Next answer.", mode: "summary" });
  });
});

describe("VoiceLoop span", () => {
  it("reports how long the loop was on and which thread it talked to", () => {
    const fake = fakePlayer();
    let clock = 5_000;
    const spans: VoiceLoopSpan[] = [];
    const loop = new VoiceLoop({
      player: fake.player,
      listen: () => undefined,
      send: () => undefined,
      now: () => clock,
      onSpan: (span) => spans.push(span),
    });
    loop.update({ threadId: "thread-1", reply: null, working: false });
    loop.start();
    clock += 90_000;
    expect(spans).toEqual([]);
    loop.stop();
    loop.stop();
    expect(spans).toEqual([{ threadId: "thread-1", startedAt: 5_000, endedAt: 95_000 }]);
  });
});
