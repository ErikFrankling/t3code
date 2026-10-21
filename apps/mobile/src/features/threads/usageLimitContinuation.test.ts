import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { usageLimitContinuationTargets } from "./usageLimitContinuation";

const claude = ProviderDriverKind.make("claudeAgent");
const provider = (instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: claude,
    continuation: { groupKey: "claude:host" },
    enabled: true,
    status: "ready",
    ...overrides,
  }) as ServerProvider;

describe("usageLimitContinuationTargets", () => {
  it("offers other accounts that resume the same native session", () => {
    const providers = [
      provider("claudeAgent"),
      provider("claudeAgent_claude_2", { displayName: "Claude 2" }),
      provider("claude_work", { continuation: { groupKey: "claude:shared:work" } }),
      provider("claude_off", { enabled: false }),
      provider("claude_broken", { status: "error" }),
      provider("codex", {
        driver: ProviderDriverKind.make("codex"),
        continuation: { groupKey: "claude:host" },
      }),
    ];
    expect(
      usageLimitContinuationTargets(providers, ProviderInstanceId.make("claudeAgent")),
    ).toEqual([{ instanceId: "claudeAgent_claude_2", label: "Claude 2" }]);
    expect(
      usageLimitContinuationTargets(providers, ProviderInstanceId.make("claudeAgent_claude_2")),
    ).toEqual([{ instanceId: "claudeAgent", label: "claudeAgent" }]);
  });

  it("offers nothing without a continuation group", () => {
    const providers = [provider("a", { continuation: undefined }), provider("b")];
    expect(usageLimitContinuationTargets(providers, ProviderInstanceId.make("a"))).toEqual([]);
  });
});
