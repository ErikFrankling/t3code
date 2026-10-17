import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ModelSelection,
  PERSONAL_AGENT_THREAD_ID,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useComposerDraftStore } from "~/composerDraftStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { useConnectedEnvironmentIds, usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerProvidersAtom } from "~/state/server";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

function readyProviderDefault(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | undefined {
  const provider =
    providers.find((entry) => entry.enabled && entry.status === "ready") ??
    providers.find((entry) => entry.enabled);
  const model =
    provider?.models.find((entry) => entry.isDefault && !entry.isCustom) ?? provider?.models[0];
  return provider && model ? createModelSelection(provider.instanceId, model.slug) : undefined;
}

/**
 * The model the personal agent's first run uses: the one a new chat would
 * start with, else the first ready provider's default. The server falls back
 * to the configured default model when this is absent.
 */
function initialModelSelection(): ModelSelection | undefined {
  const { stickyActiveProvider, stickyModelSelectionByProvider } = useComposerDraftStore.getState();
  return (
    (stickyActiveProvider ? stickyModelSelectionByProvider[stickyActiveProvider] : undefined) ??
    readyProviderDefault(appAtomRegistry.get(primaryServerProvidersAtom))
  );
}

/** A thread created a moment ago reaches the client store shortly after. */
async function waitForThreadShell(ref: Parameters<typeof readThreadShell>[0]) {
  for (let attempt = 0; attempt < 100 && readThreadShell(ref) === null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function usePersonalAgent() {
  const ensure = useAtomCommand(projectEnvironment.ensurePersonalAgent, { reportFailure: false });
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params as { threadId?: ThreadId }).threadId ?? null,
  });
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => (params as { environmentId?: EnvironmentId }).environmentId ?? null,
  });
  // A browser served by an environment has it as primary. The desktop app
  // talking to a remote server has no primary, so use the environment on
  // screen, else the first connected one.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const isConnected = (id: EnvironmentId | null): id is EnvironmentId =>
    id !== null && connectedEnvironmentIds.includes(id);
  const environmentId = isConnected(primaryEnvironmentId)
    ? primaryEnvironmentId
    : isConnected(routeEnvironmentId)
      ? routeEnvironmentId
      : (connectedEnvironmentIds[0] ?? null);
  const connected = environmentId !== null;

  const openPersonalAgent = useCallback(
    async (options?: { readonly replace?: boolean }): Promise<string | null> => {
      if (environmentId === null) {
        const message = "Connect to an environment first.";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open the personal agent",
            description: message,
          }),
        );
        return message;
      }
      const modelSelection = initialModelSelection();
      const result = await ensure({
        environmentId,
        input: modelSelection === undefined ? {} : { modelSelection },
      });
      if (result._tag !== "Success") {
        if (isAtomCommandInterrupted(result)) return null;
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Could not open it.";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open the personal agent",
            description: message,
          }),
        );
        return message;
      }
      // The thread route sends an unknown thread home, so wait for it to arrive.
      await waitForThreadShell(scopeThreadRef(environmentId, result.value.threadId));
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
        ...(options?.replace ? { replace: true } : {}),
      });
      return null;
    },
    [ensure, environmentId, navigate],
  );

  return {
    connected,
    openPersonalAgent,
    isPersonalAgentOpen: routeThreadId === PERSONAL_AGENT_THREAD_ID,
  };
}
