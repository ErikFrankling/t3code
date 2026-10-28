// @effect-diagnostics globalTimers:off -- Plain promises, like voiceLoop.test.ts.
import { describe, expect, it } from "vite-plus/test";

import type { ReadAloudPlayer, ReadAloudSnapshot } from "./readAloud.ts";
import { VOICE_LOOP_CUE_KEY } from "./voiceLoop.ts";
import { VoiceSession } from "./voiceSession.ts";

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
  return { player, started, finish: () => set({ phase: "done" }) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  const fake = fakePlayer();
  const calls: string[] = [];
  const done: string[] = [];
  let heard = false;
  let silence: (() => void) | null = null;
  const session = new VoiceSession({
    player: fake.player,
    listen: () => void calls.push("listen"),
    send: () => void calls.push("send"),
    discard: () => void calls.push("discard"),
    heard: () => heard,
    onDone: (key, status) => void done.push(`${key}:${status}`),
    setTimeout: (run) => {
      silence = run;
      return () => {
        if (silence === run) silence = null;
      };
    },
  });
  return {
    ...fake,
    calls,
    done,
    session,
    hear: () => {
      heard = true;
    },
    silence: () => silence?.(),
  };
}

/** Plays whatever is loading to the end, the cue included. */
async function finishAll(fake: { finish: () => void }) {
  for (let i = 0; i < 4; i++) {
    fake.finish();
    await tick();
  }
}

describe("VoiceSession", () => {
  it("stays quiet until the agent has something to say", async () => {
    const { session, started, calls } = setup();
    session.start();
    await tick();
    expect(session.getSnapshot().phase).toBe("idle");
    expect(started).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reads a message as written, then opens the microphone for the answer", async () => {
    const fake = setup();
    fake.session.start();
    fake.session.say({ key: "u1", text: "The build passed. Ship it?" });
    expect(fake.session.getSnapshot().phase).toBe("speaking");
    expect(fake.started[0]).toEqual({
      key: "u1",
      text: "The build passed. Ship it?",
      mode: "full",
    });
    fake.finish();
    await tick();
    expect(fake.done).toEqual(["u1:played"]);
    expect(fake.started.at(-1)?.key).toBe(VOICE_LOOP_CUE_KEY);
    await finishAll(fake);
    expect(fake.session.getSnapshot().phase).toBe("listening");
    fake.session.endTurn();
    await tick();
    expect(fake.calls).toEqual(["listen", "send"]);
    // No forced reply: back to waiting quietly.
    expect(fake.session.getSnapshot().phase).toBe("idle");
  });

  it("reads a message that asks for no answer and leaves the microphone shut", async () => {
    const fake = setup();
    fake.session.start();
    fake.session.say({ key: "u1", text: "The build passed.", listen: false });
    expect(fake.session.getSnapshot().phase).toBe("speaking");
    fake.finish();
    await tick();
    await finishAll(fake);
    expect(fake.done).toEqual(["u1:played"]);
    expect(fake.calls).toEqual([]);
    expect(fake.started.map((s) => s.key)).toEqual(["u1"]);
    expect(fake.session.getSnapshot().phase).toBe("idle");
    // Erik can still answer on his own, and a later message is read as usual.
    fake.session.talk();
    await finishAll(fake);
    expect(fake.session.getSnapshot().phase).toBe("listening");
    expect(fake.calls).toEqual(["listen"]);
  });

  it("with several waiting, only the last one decides whether the microphone opens", async () => {
    const fake = setup();
    fake.session.start();
    fake.session.say({ key: "u1", text: "First." });
    fake.session.say({ key: "u2", text: "Second.", listen: false });
    fake.finish();
    await tick();
    fake.finish();
    await tick();
    expect(fake.done).toEqual(["u1:played", "u2:played"]);
    expect(fake.calls).toEqual([]);
    expect(fake.session.getSnapshot().phase).toBe("idle");
  });

  it("lets Erik talk any time, and holds the agent's message until he has sent", async () => {
    const fake = setup();
    fake.session.start();
    fake.session.talk();
    await finishAll(fake);
    expect(fake.session.getSnapshot().phase).toBe("listening");
    fake.session.say({ key: "u1", text: "Meeting in five minutes." });
    expect(fake.session.getSnapshot()).toMatchObject({ phase: "listening", waiting: 1 });
    fake.session.endTurn();
    await tick();
    expect(fake.session.getSnapshot().phase).toBe("speaking");
    expect(fake.started.at(-1)?.key).toBe("u1");
  });

  it("drops a turn the agent opened if nothing is said, but keeps one with words", async () => {
    const fake = setup();
    fake.session.start();
    fake.session.say({ key: "u1", text: "Done." });
    await finishAll(fake);
    expect(fake.session.getSnapshot().phase).toBe("listening");
    fake.silence();
    expect(fake.calls).toEqual(["listen", "discard"]);
    expect(fake.session.getSnapshot().phase).toBe("idle");

    fake.session.say({ key: "u2", text: "Next one?" });
    await finishAll(fake);
    fake.hear();
    fake.silence();
    expect(fake.session.getSnapshot().phase).toBe("listening");
  });

  it("a discarded turn sends nothing, and what waited is said next", async () => {
    const fake = setup();
    fake.session.start();
    fake.session.talk();
    await finishAll(fake);
    fake.session.say({ key: "u1", text: "Meanwhile, the build passed." });
    fake.session.discardTurn();
    expect(fake.calls).toEqual(["listen", "discard"]);
    expect(fake.session.getSnapshot().phase).toBe("speaking");
    expect(fake.started.at(-1)?.key).toBe("u1");
  });

  it("talking over the agent skips the rest of its message", async () => {
    const fake = setup();
    fake.session.start();
    fake.session.say({ key: "u1", text: "A long explanation." });
    fake.session.endTurn();
    expect(fake.done).toEqual(["u1:played"]);
    await finishAll(fake);
    expect(fake.session.getSnapshot().phase).toBe("listening");
  });

  it("volume up while Erik answers plays the message again over the recording", async () => {
    const fake = setup();
    fake.session.start();
    fake.session.say({ key: "u1", text: "Ship it?" });
    await finishAll(fake);
    expect(fake.session.getSnapshot().phase).toBe("listening");
    fake.session.replay();
    expect(fake.started.at(-1)?.key).toBe("u1");
    expect(fake.session.getSnapshot().phase).toBe("listening");
    expect(fake.calls).toEqual(["listen"]);
  });

  it("opens the microphone before the platform's chime plays", async () => {
    const fake = fakePlayer();
    const order: string[] = [];
    const session = new VoiceSession({
      player: fake.player,
      listen: () => void order.push("listen"),
      send: () => undefined,
      discard: () => undefined,
      heard: () => false,
      cue: () => void order.push("chime"),
      setTimeout: () => () => undefined,
    });
    session.start();
    session.talk();
    await tick();
    await tick();
    expect(order).toEqual(["listen", "chime"]);
    expect(session.getSnapshot().phase).toBe("listening");
    expect(fake.started).toEqual([]);
  });

  it("never says the same message twice, and reports the unheard ones when it ends", async () => {
    const fake = setup();
    fake.session.start();
    fake.session.talk();
    await finishAll(fake);
    fake.session.say({ key: "u1", text: "One." });
    fake.session.say({ key: "u1", text: "One." });
    expect(fake.session.getSnapshot().waiting).toBe(1);
    fake.session.stop();
    expect(fake.done).toEqual(["u1:skipped"]);
    fake.session.say({ key: "u2", text: "Off now." });
    expect(fake.started.some((s) => s.key === "u2")).toBe(false);
  });
});
