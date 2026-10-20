import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, PERSONAL_AGENT_THREAD_ID } from "@t3tools/contracts";

export type PersonalAgentEnvironment = {
  readonly environmentId: EnvironmentId;
  readonly connectionState: string;
};

/**
 * The environment whose personal agent Home offers: the filtered one when it
 * is connected, else the first connected one that already has the agent, else
 * the first connected one (opening it there creates the agent).
 */
export function resolvePersonalAgentEnvironment(input: {
  readonly environments: ReadonlyArray<PersonalAgentEnvironment>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly threads: ReadonlyArray<Pick<EnvironmentThreadShell, "environmentId" | "id">>;
}): EnvironmentId | null {
  const connected = input.environments
    .filter((environment) => environment.connectionState === "connected")
    .map((environment) => environment.environmentId);
  if (input.selectedEnvironmentId !== null) {
    return connected.includes(input.selectedEnvironmentId) ? input.selectedEnvironmentId : null;
  }
  return (
    connected.find((environmentId) =>
      input.threads.some(
        (thread) =>
          thread.environmentId === environmentId && thread.id === PERSONAL_AGENT_THREAD_ID,
      ),
    ) ??
    connected[0] ??
    null
  );
}
