import { assert, it } from "@effect/vitest";

import { foldSpokenLog, summarizeDay } from "./PersonalAgentHome.ts";

const line = (event: Record<string, unknown>) => JSON.stringify(event);

it("folds the speak log into one entry per utterance, newest first", () => {
  const lines = [
    line({
      time: "2026-10-23T03:07:11+0200",
      event: "queued",
      id: "a",
      text: "Long text",
      source: "personal-agent",
    }),
    line({
      time: "2026-10-23T03:07:12+0200",
      event: "generated",
      id: "a",
      spoken_text: "Short text",
      seconds: 3.5,
    }),
    line({ time: "2026-10-23T03:07:13+0200", event: "speaking", id: "a", sink: "AirPods" }),
    line({ time: "2026-10-23T03:07:17+0200", event: "spoken", id: "a", sink: "AirPods" }),
    line({
      time: "2026-10-23T03:07:18+0200",
      event: "reply_window",
      id: "a",
      result: "not configured",
    }),
    line({ time: "2026-10-23T03:08:00+0200", event: "queued", id: "b", text: "Second" }),
    line({
      time: "2026-10-23T03:08:01+0200",
      event: "waiting",
      id: "b",
      reason: "Erik is dictating",
    }),
    "not json",
    line({ time: "2026-10-23T03:09:00+0200", event: "queued", id: "c", text: "Third" }),
    line({ time: "2026-10-23T03:09:30+0200", event: "dropped", id: "c", reason: "expired" }),
  ];
  const entries = foldSpokenLog(lines, new Set(["a"]), "/home/erik/.local/state/speak/audio");
  assert.deepStrictEqual(
    entries.map((entry) => [entry.id, entry.status, entry.reason]),
    [
      ["c", "dropped", "expired"],
      ["b", "waiting", "Erik is dictating"],
      ["a", "spoken", null],
    ],
  );
  const spoken = entries[2]!;
  assert.strictEqual(spoken.text, "Short text");
  assert.strictEqual(spoken.sink, "AirPods");
  assert.strictEqual(spoken.seconds, 3.5);
  assert.strictEqual(spoken.audioPath, "/home/erik/.local/state/speak/audio/a.wav");
  assert.strictEqual(spoken.queuedAt, "2026-10-23T03:07:11+02:00");
  assert.isNull(entries[0]!.audioPath);
});

it("sums Time's minutes into activities and keeps the latest as current", () => {
  const summary = summarizeDay("2026-10-23", {
    minutes: [
      { activity: "coding", project: "t3code" },
      { activity: "coding", project: "t3code" },
      { activity: null },
      { activity: "social", project: null },
    ],
  });
  assert.deepStrictEqual(summary, {
    date: "2026-10-23",
    totalMinutes: 3,
    activities: [
      { activity: "coding", minutes: 2 },
      { activity: "social", minutes: 1 },
    ],
    current: "social",
  });
  assert.isNull(summarizeDay("2026-10-23", { nope: true }));
});
