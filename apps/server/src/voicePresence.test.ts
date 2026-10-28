import { describe, expect, it } from "vite-plus/test";

import { PRESENCE_TTL_MS, UTTERANCE_TTL_MS, VoicePresence } from "./voicePresence.ts";

function fakeClock() {
  let now = 1_000_000;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
      }
    },
  };
}

const phone = { deviceId: "phone", threadId: "personal-agent", on: true } as const;

describe("VoicePresence", () => {
  it("refuses to queue anything while no phone has voice mode on", () => {
    const presence = new VoicePresence(fakeClock());
    expect(presence.presence().present).toBe(false);
    expect(presence.say({ id: "a", text: "Hi", threadId: "personal-agent" })).toBeNull();
  });

  it("hands a message to the waiting poll at once and records it played", async () => {
    const clock = fakeClock();
    const presence = new VoicePresence(clock);
    const poll = presence.beat({ ...phone, waitMs: 20_000 });
    expect(presence.presence()).toMatchObject({ present: true, threadId: "personal-agent" });
    expect(presence.say({ id: "a", text: "The build passed.", threadId: "personal-agent" })).toBe(
      "queued",
    );
    expect((await poll).map((u) => u.text)).toEqual(["The build passed."]);
    expect(presence.status("a")).toBe("delivered");
    await presence.beat({ ...phone, done: [{ id: "a", status: "played" }] });
    expect(presence.status("a")).toBe("played");
  });

  it("passes on whether the phone should open the microphone after a message", async () => {
    const presence = new VoicePresence(fakeClock());
    await presence.beat(phone);
    presence.say({ id: "a", text: "Quiet.", threadId: "personal-agent", listen: false });
    presence.say({ id: "b", text: "Talk to me.", threadId: "personal-agent" });
    const heard = await presence.beat(phone);
    expect(heard.map((u) => [u.id, u.listen])).toEqual([
      ["a", false],
      ["b", undefined],
    ]);
  });

  it("only queues for the thread the phone is in voice mode on", async () => {
    const presence = new VoicePresence(fakeClock());
    await presence.beat({ ...phone, threadId: "other-thread" });
    expect(presence.say({ id: "a", text: "Hi", threadId: "personal-agent" })).toBeNull();
  });

  it("forgets the phone when voice mode is turned off or its polls stop", async () => {
    const clock = fakeClock();
    const presence = new VoicePresence(clock);
    await presence.beat(phone);
    clock.advance(PRESENCE_TTL_MS - 1);
    expect(presence.presence().present).toBe(true);
    clock.advance(2);
    expect(presence.presence().present).toBe(false);

    await presence.beat(phone);
    presence.say({ id: "a", text: "Hi", threadId: "personal-agent" });
    await presence.beat({ ...phone, on: false });
    expect(presence.presence().present).toBe(false);
    expect(presence.status("a")).toBe("skipped");
  });

  it("a poll that times out returns nothing; a stale message expires", async () => {
    const clock = fakeClock();
    const presence = new VoicePresence(clock);
    const poll = presence.beat({ ...phone, waitMs: 20_000 });
    clock.advance(20_000);
    expect(await poll).toEqual([]);
    presence.say({ id: "a", text: "Hi", threadId: "personal-agent" });
    clock.advance(UTTERANCE_TTL_MS + 1);
    expect(presence.status("a")).toBe("expired");
    expect(await presence.beat(phone)).toEqual([]);
  });

  it("offers a delivered message again if the phone never reported it", async () => {
    const clock = fakeClock();
    const presence = new VoicePresence(clock);
    await presence.beat(phone);
    presence.say({ id: "a", text: "Hi", threadId: "personal-agent" });
    expect(await presence.beat(phone)).toHaveLength(1);
    expect(await presence.beat(phone)).toHaveLength(0);
    clock.advance(31_000);
    expect(await presence.beat(phone)).toHaveLength(1);
  });
});
