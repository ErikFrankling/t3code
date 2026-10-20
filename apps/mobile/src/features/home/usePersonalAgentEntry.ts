import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, PERSONAL_AGENT_THREAD_ID, type ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type PersonalAgentEnvironment,
  resolvePersonalAgentEnvironment,
} from "./personal-agent-environment";

/** A thread created a moment ago reaches the client store shortly after. */
async function waitForThreadShell(environmentId: EnvironmentId, threadId: ThreadId) {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  for (let attempt = 0; attempt < 100 && appAtomRegistry.get(atom) === null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export type PersonalAgentEntry = {
  /** Null until the agent exists, or while it is archived. */
  readonly thread: EnvironmentThreadShell | null;
  readonly opening: boolean;
  readonly open: () => void;
};

export function usePersonalAgentEntry(input: {
  readonly environments: ReadonlyArray<PersonalAgentEnvironment>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
}): PersonalAgentEntry | null {
  const ensure = useAtomCommand(projectEnvironment.ensurePersonalAgent, { reportFailure: false });
  const [opening, setOpening] = useState(false);
  const environmentId = resolvePersonalAgentEnvironment(input);
  if (environmentId === null) return null;
  const thread =
    input.threads.find(
      (candidate) =>
        candidate.environmentId === environmentId &&
        candidate.id === PERSONAL_AGENT_THREAD_ID &&
        candidate.archivedAt === null,
    ) ?? null;

  const open = () => {
    if (thread !== null) {
      input.onSelectThread(thread);
      return;
    }
    if (opening) return;
    setOpening(true);
    void (async () => {
      // The server creates the folder, project and pinned thread on first use,
      // and unarchives the thread if it was archived.
      const result = await ensure({ environmentId, input: {} });
      if (result._tag !== "Success") {
        setOpening(false);
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          "Could not open the personal agent",
          error instanceof Error ? error.message : "Try again in a moment.",
        );
        return;
      }
      await waitForThreadShell(environmentId, result.value.threadId);
      setOpening(false);
      input.onSelectThread({ environmentId, id: result.value.threadId });
    })();
  };

  return { thread, opening, open };
}
