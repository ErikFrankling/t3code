import { EnvironmentId, PERSONAL_AGENT_THREAD_ID, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePersonalAgentEnvironment } from "./personal-agent-environment";

const laptop = EnvironmentId.make("laptop");
const desktop = EnvironmentId.make("desktop");
const environments = [
  { environmentId: laptop, connectionState: "connected" },
  { environmentId: desktop, connectionState: "connected" },
];

describe("resolvePersonalAgentEnvironment", () => {
  it("prefers a connected environment that already has the agent", () => {
    expect(
      resolvePersonalAgentEnvironment({
        environments,
        selectedEnvironmentId: null,
        threads: [
          { environmentId: laptop, id: ThreadId.make("other") },
          { environmentId: desktop, id: PERSONAL_AGENT_THREAD_ID },
        ],
      }),
    ).toBe(desktop);
  });

  it("falls back to the first connected environment so opening creates the agent", () => {
    expect(
      resolvePersonalAgentEnvironment({
        environments: [{ environmentId: laptop, connectionState: "offline" }, environments[1]!],
        selectedEnvironmentId: null,
        threads: [],
      }),
    ).toBe(desktop);
  });

  it("follows the environment filter, and offers nothing while it is offline", () => {
    const threads = [{ environmentId: desktop, id: PERSONAL_AGENT_THREAD_ID }];
    expect(
      resolvePersonalAgentEnvironment({ environments, selectedEnvironmentId: laptop, threads }),
    ).toBe(laptop);
    expect(
      resolvePersonalAgentEnvironment({
        environments: [{ environmentId: laptop, connectionState: "connecting" }],
        selectedEnvironmentId: laptop,
        threads,
      }),
    ).toBeNull();
  });
});
