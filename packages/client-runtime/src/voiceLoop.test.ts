// @effect-diagnostics globalTimers:off -- Plain promises, like readAloud.test.ts.
import { describe, expect, it } from "vite-plus/test";

import type { ReadAloudPlayer, ReadAloudSnapshot, ReadAloudTake } from "./readAloud.ts";
import { VOICE_LOOP_CUE, VoiceLoop, voiceLoopCueWav, type VoiceLoopSpan } from "./voiceLoop.ts";

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
    // Recording again right away; the cue plays over it.
    expect(loop.getSnapshot().phase).toBe("listening");
    expect(calls).toEqual(["listen", "send", "listen"]);
  });

  it("lets the reply already being read finish before listening", async () => {
    const { loop, player, finish, calls } = setup();
    player.start("reply", "Hello.");
    loop.start();
    expect(loop.getSnapshot().phase).toBe("reading");
    expect(calls).toEqual([]);
    finish();
    await tick();
    expect(loop.getSnapshot().phase).toBe("listening");
    expect(calls).toEqual(["listen"]);
  });

  it("ends the reading early when the turn button is pressed", async () => {
    const { loop, player, finish, calls } = setup();
    player.start("reply", "A long answer.");
    loop.start();
    loop.endTurn();
    await tick();
    expect(loop.getSnapshot().phase).toBe("listening");
    expect(calls).toEqual(["listen"]);
  });

  it("stops reading and listening when turned off", async () => {
    const { loop, player, finish, calls } = setup();
    loop.start();
    loop.stop();
    expect(player.getSnapshot().phase).toBe("idle");
    finish();
    await tick();
    // The turn had started recording; turning off leaves it to the composer.
    expect(calls).toEqual(["listen"]);
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
  /** A loop that read the reply "r1" to the end and is now recording your turn. */
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
    expect(harness.loop.getSnapshot().phase).toBe("listening");
    return harness;
  }

  it("on your turn, plays the last reply again from the kept audio over the recording", async () => {
    const { loop, started, replayed, calls } = await afterReply();
    const requested = started.length;
    loop.replay();
    expect(replayed).toEqual(["r1"]);
    // No new summary is asked for.
    expect(started).toHaveLength(requested);
    // The recording goes on: still your turn, nothing sent, no new recording.
    expect(loop.getSnapshot().phase).toBe("listening");
    expect(calls).toEqual(["listen", "send", "listen"]);
  });

  it("restarts the reply while it is being read, then it is your turn", async () => {
    const harness = setup();
    harness.loop.update({ reply: null, working: false });
    harness.loop.start();
    harness.finish();
    await tick();
    harness.loop.endTurn();
    await tick();
    harness.loop.update({ reply: { key: "r1", text: "It works." }, working: false });
    expect(harness.loop.getSnapshot().phase).toBe("reading");
    const before = harness.started.length;
    harness.loop.replay();
    expect(harness.started).toHaveLength(before + 1);
    expect(harness.started.at(-1)?.key).toBe("r1");
    expect(harness.loop.getSnapshot().phase).toBe("reading");
    harness.finish();
    await tick();
    expect(harness.loop.getSnapshot().phase).toBe("listening");
  });

  it("never stops or sends your turn", async () => {
    const { loop, calls } = await afterReply();
    loop.replay();
    loop.replay();
    expect(loop.getSnapshot().phase).toBe("listening");
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

describe("VoiceLoop recording starts with the cue", () => {
  it("records from the moment the turn starts, while the cue plays, and plays the cue without the player", async () => {
    const fake = fakePlayer();
    const calls: string[] = [];
    let endCue: () => void = () => undefined;
    const loop = new VoiceLoop({
      player: fake.player,
      listen: () => void calls.push("listen"),
      send: () => void calls.push("send"),
      cue: () =>
        new Promise<void>((resolve) => {
          calls.push("cue");
          endCue = resolve;
        }),
    });
    loop.start();
    await tick();
    // Listening already, with the cue still playing: words said as it plays are recorded.
    expect(calls).toEqual(["listen", "cue"]);
    expect(loop.getSnapshot().phase).toBe("listening");
    // The read-aloud player was never used for it, so its controls do not flash.
    expect(fake.started).toEqual([]);
    endCue();
    await tick();
    expect(loop.getSnapshot().phase).toBe("listening");
  });
});

describe("voiceLoopCueWav", () => {
  it("is a short 16-bit mono WAV, over before a sentence starts", () => {
    const bytes = Uint8Array.from(atob(voiceLoopCueWav()), (char) => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const text = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
    expect([text(0), text(8), text(36)]).toEqual(["RIFF", "WAVE", "data"]);
    const rate = view.getUint32(24, true);
    const seconds = view.getUint32(40, true) / 2 / rate;
    expect(view.getUint16(22, true)).toBe(1);
    expect(seconds).toBeGreaterThan(0.15);
    expect(seconds).toBeLessThan(0.4);
  });
});
