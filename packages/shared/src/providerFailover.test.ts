import { describe, expect, it } from "vite-plus/test";

import { pickProviderFailover, providerContinuationSiblings } from "./providerFailover.ts";

const candidate = (instanceId: string, overrides: Record<string, unknown> = {}) => ({
  instanceId,
  driver: "claudeAgent",
  continuationGroupKey: "claude:host" as string | undefined,
  available: true,
  ...overrides,
});

describe("providerFailover", () => {
  const candidates = [
    candidate("claudeAgent"),
    candidate("claudeAgent_claude_2"),
    candidate("claude_work", { continuationGroupKey: "claude:shared:work" }),
    candidate("claude_off", { available: false }),
    candidate("codex", { driver: "codex" }),
  ];

  it("lists only available instances in the same driver and continuation group", () => {
    expect(
      providerContinuationSiblings(candidates, "claudeAgent").map((c) => c.instanceId),
    ).toEqual(["claudeAgent_claude_2"]);
    expect(providerContinuationSiblings(candidates, "unknown")).toEqual([]);
    expect(
      providerContinuationSiblings(
        [candidate("a", { continuationGroupKey: undefined }), candidate("b")],
        "a",
      ),
    ).toEqual([]);
  });

  it("skips siblings whose limit has not reset", () => {
    const pick = (exhausted: Array<[string, number]>, nowMs: number) =>
      pickProviderFailover({
        candidates,
        currentInstanceId: "claudeAgent",
        exhaustedUntilMs: new Map(exhausted),
        nowMs,
      })?.instanceId ?? null;
    expect(pick([], 0)).toBe("claudeAgent_claude_2");
    expect(pick([["claudeAgent_claude_2", 100]], 50)).toBeNull();
    expect(pick([["claudeAgent_claude_2", 100]], 100)).toBe("claudeAgent_claude_2");
  });
});
