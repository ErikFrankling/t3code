// @effect-diagnostics globalDate:off -- Plain timestamps, shared with React Native; no Effect runtime here.
import type { ActivityEvent } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { FocusReporter, readAloudEvent, voiceModeEvent } from "./activityLog.ts";
import { VOICE_LOOP_CUE_KEY } from "./voiceLoop.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("activity events", () => {
  it("reports a played message as ISO times and seconds", () => {
    expect(
      readAloudEvent({ key: "m1", startedAt: 0, endedAt: 90_000, seconds: 72.46 }, "web"),
    ).toEqual({
      kind: "t3.readaloud.played",
      messageId: "m1",
      client: "web",
      startedAt: "1970-01-01T00:00:00.000Z",
      endedAt: "1970-01-01T00:01:30.000Z",
      seconds: 72.5,
    });
  });

  it("leaves out voice mode's spoken cue", () => {
    expect(
      readAloudEvent({ key: VOICE_LOOP_CUE_KEY, startedAt: 0, endedAt: 2000, seconds: 2 }, "web"),
    ).toBeNull();
  });

  it("names the thread of a voice span only when it is known", () => {
    expect(
      voiceModeEvent({ threadId: null, startedAt: 0, endedAt: 1000 }, "mobile"),
    ).not.toHaveProperty("threadId");
    expect(voiceModeEvent({ threadId: "t1", startedAt: 0, endedAt: 1000 }, "mobile")).toMatchObject(
      {
        threadId: "t1",
      },
    );
  });
});

describe("FocusReporter", () => {
  it("counts a thread only after it stays, then beats while it stays", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T10:00:00.000Z"));
    const sent: ActivityEvent[] = [];
    const reporter = new FocusReporter({ client: "web", send: (event) => void sent.push(event) });

    reporter.focus("a");
    await vi.advanceTimersByTimeAsync(3_000);
    reporter.focus("b");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent, "skimming past a thread is not focus").toEqual([]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent.map((e) => e.kind === "thread.focus" && e.threadId)).toEqual(["b"]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toHaveLength(3);

    reporter.focus(null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent, "a hidden window stops the beat").toHaveLength(3);
  });
});
