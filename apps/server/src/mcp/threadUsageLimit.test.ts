import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadUsageLimit } from "./OrchestratorMcpService.ts";

const runId = RunId.make("run:limited");
const resetAt = "2026-10-21T15:00:00.000Z";
const limited = {
  status: "failed" as const,
  lastErrorClass: "usage_limit" as const,
  usageLimitResetAt: resetAt,
  latestRunId: runId,
  limitRecovery: null,
};

describe("threadUsageLimit", () => {
  it("reports the stopped run, its reset and the limit card's settings", () => {
    expect(threadUsageLimit(limited)).toEqual({
      stoppedRunId: runId,
      resetAt,
      resumeAtReset: false,
      snoozedUntilReset: false,
    });
    expect(
      threadUsageLimit({
        ...limited,
        limitRecovery: { runId, resetAt, autoResume: true, snooze: true },
      }),
    ).toMatchObject({ resumeAtReset: true, snoozedUntilReset: true });
  });

  it("ignores recovery set for an older limit and threads not stopped by one", () => {
    expect(
      threadUsageLimit({
        ...limited,
        limitRecovery: { runId: RunId.make("run:older"), resetAt, autoResume: true },
      }),
    ).toMatchObject({ resumeAtReset: false });
    expect(threadUsageLimit({ ...limited, lastErrorClass: "provider_error" })).toBeNull();
    expect(threadUsageLimit({ ...limited, status: "completed" })).toBeNull();
  });
});
