import { Button } from "../../components/ui/Button";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useDeadlinePassed } from "../../lib/clock";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { usageLimitContinuationTargets } from "./usageLimitContinuation";

export function UsageLimitRecoveryCard({
  thread,
  environmentId,
  providers,
  onSelectModel,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  onSelectModel: (modelSelection: ModelSelection) => void;
}) {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "continue on another account");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const canSchedule =
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  const resetPassed = useDeadlinePassed(resetAt === null ? null : Date.parse(resetAt));
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
  if (
    thread.runtime?.status !== "failed" ||
    thread.runtime.lastErrorClass !== "usage_limit" ||
    !runId
  )
    return null;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    thread.snoozedUntil !== null &&
    Date.parse(thread.snoozedUntil) === Date.parse(resetAt);
  const continuationTargets = usageLimitContinuationTargets(
    providers,
    thread.modelSelection.instanceId,
  );
  async function continueOn(instanceId: ModelSelection["instanceId"]) {
    if (!runId) return;
    const modelSelection = { ...thread.modelSelection, instanceId };
    setPending(true);
    setError(null);
    onSelectModel(modelSelection);
    const result = await startTurn({
      environmentId,
      input: {
        threadId: thread.id,
        manualContinuationOfRunId: runId,
        modelSelection,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          text: "Continue where you left off.",
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        dispatchMode: "start",
      },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not continue on that account.");
    }
  }
  async function toggle(action: "resume" | "snooze") {
    if (!resetAt || !runId || !canSchedule) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: {
        threadId: thread.id,
        limitRecovery: {
          runId,
          resetAt,
          ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
        },
      },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    }
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm text-warning-foreground">
        {resetAt
          ? `Usage limit resets ${DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleString()}.`
          : "The provider did not report a reset time. Retry manually when your limit is available."}
      </Text>
      {continuationTargets.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {continuationTargets.map((target) => (
            <Pressable
              key={target.instanceId}
              accessibilityRole="button"
              disabled={pending}
              onPress={() => void continueOn(target.instanceId)}
              className="self-start rounded-lg bg-primary px-3 py-2 active:opacity-70"
            >
              <Text className="text-sm text-primary-foreground">Continue on {target.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {canSchedule ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={scheduled ? "Cancel auto-resume" : "Resume at reset"}
            tone="secondary"
            disabled={pending}
            onPress={() => void toggle("resume")}
          />
          <Button
            label={snoozed ? "Wake now" : "Snooze until reset"}
            tone="secondary"
            disabled={pending || (!snoozed && resetPassed)}
            onPress={() => void toggle("snooze")}
          />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
