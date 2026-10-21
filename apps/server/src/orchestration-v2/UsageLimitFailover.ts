import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  latestRootProviderFailure,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { pickProviderFailover } from "@t3tools/shared/providerFailover";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { adapterCandidates, ProviderInstanceLimits } from "./ProviderInstanceLimits.ts";

/** Built-in instances are named after their driver, e.g. `claudeAgent` is "Claude". */
const defaultInstanceLabel = (instanceId: string) => {
  const name = instanceId.replace(/Agent$/, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const formatResetTime = (untilMs: number) =>
  DateTime.formatLocal(DateTime.makeUnsafe(untilMs), { hour: "2-digit", minute: "2-digit" });

export const failoverNote = (input: {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly resetsAtMs: number;
}) =>
  `${input.fromLabel} reached its usage limit (resets ${formatResetTime(input.resetsAtMs)}), so T3 Code continued this thread on ${input.toLabel}. Continue where you left off.`;

export class UsageLimitFailoverReactor extends Context.Service<
  UsageLimitFailoverReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/UsageLimitFailover/UsageLimitFailoverReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const limits = yield* ProviderInstanceLimits;
  const adapters = yield* ProviderAdapterRegistryV2;
  const providerRegistry = yield* Effect.serviceOption(ProviderRegistry);
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

  const labeller = Effect.gen(function* () {
    const providers: ReadonlyArray<ServerProvider> = Option.isSome(providerRegistry)
      ? yield* providerRegistry.value.getProviders
      : [];
    const configured = Option.isSome(serverSettings)
      ? ((yield* serverSettings.value.getSettings.pipe(Effect.option)).pipe(
          Option.map((settings) => settings.providerInstances),
          Option.getOrUndefined,
        ) ?? {})
      : {};
    return (instanceId: string) =>
      configured[instanceId as keyof typeof configured]?.displayName ??
      providers.find((provider) => provider.instanceId === instanceId)?.displayName ??
      defaultInstanceLabel(instanceId);
  });

  const handle: UsageLimitFailoverReactor["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      // The failed run and its error item arrive as separate events, in either order.
      if (
        !(event.type === "run.updated" && event.payload.status === "failed") &&
        !(
          event.type === "turn-item.updated" &&
          event.payload.type === "error" &&
          event.payload.failure?.class === "usage_limit"
        )
      ) {
        return;
      }
      const projection = yield* engine.getThreadProjection(event.threadId);
      const thread = projection.thread;
      if (thread.archivedAt !== null || thread.deletedAt !== null) return;
      const run = usageLimitBlockedRun(projection.runs, projection.turnItems, null);
      if (run === null || run.providerInstanceId === null) return;
      const failure = latestRootProviderFailure(run, projection.turnItems);
      if (failure?.class !== "usage_limit") return;
      if (projection.runtimeRequests.some((request) => request.status === "pending")) return;

      const limitedInstanceId = run.providerInstanceId;
      const untilMs = yield* limits.markExhausted(limitedInstanceId, failure.resetAt);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const target = pickProviderFailover({
        candidates: yield* adapterCandidates(adapters),
        currentInstanceId: limitedInstanceId,
        exhaustedUntilMs: yield* limits.exhaustedUntil,
        nowMs,
      });
      // With every sibling exhausted the thread waits for the reset
      // (UsageLimitRecoveryWorker resumes it when auto-resume is on).
      if (target === null) return;

      const labelFor = yield* labeller;
      yield* Effect.logInfo("orchestration-v2.usage-limit-failover", {
        threadId: thread.id,
        runId: run.id,
        from: limitedInstanceId,
        to: target.instanceId,
      });
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`limit-failover:${run.id}`),
        threadId: thread.id,
        messageId: MessageId.make(`limit-failover:${run.id}`),
        manualContinuationOfRunId: run.id,
        modelSelection: { ...thread.modelSelection, instanceId: target.instanceId },
        text: failoverNote({
          fromLabel: labelFor(limitedInstanceId),
          toLabel: labelFor(target.instanceId),
          resetsAtMs: untilMs,
        }),
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
      // The limit held the queue; messages sent meanwhile run on the new account next.
      if (
        projection.runs.some((queued) => queued.status === "queued" && queued.queueHeld === true)
      ) {
        yield* engine.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`limit-failover-queue:${run.id}`),
          threadId: thread.id,
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("usage-limit failover failed", { threadId: event.threadId, cause }),
      ),
    );

  const start: UsageLimitFailoverReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("usage-limit failover event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies UsageLimitFailoverReactor["Service"];
});

export const layer = Layer.effect(UsageLimitFailoverReactor, make);
