import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import {
  pickProviderFailover,
  type ProviderFailoverCandidate,
} from "@t3tools/shared/providerFailover";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";

/** Used when a limit error does not say when the window resets. */
const UNKNOWN_RESET_MS = 60 * 60 * 1000;
/** A reset time already in the past still keeps the instance out briefly, so threads do not bounce. */
const STALE_RESET_MS = 5 * 60 * 1000;

/**
 * Which provider instances hit a usage limit and until when. Kept in memory:
 * after a restart the first limited turn on an exhausted account records it
 * again and fails over.
 */
export class ProviderInstanceLimits extends Context.Service<
  ProviderInstanceLimits,
  {
    readonly markExhausted: (
      instanceId: ProviderInstanceId,
      resetAt: string | null | undefined,
    ) => Effect.Effect<number>;
    readonly exhaustedUntil: Effect.Effect<ReadonlyMap<string, number>>;
  }
>()("t3/orchestration-v2/ProviderInstanceLimits") {}

export const limitsLayer = Layer.effect(
  ProviderInstanceLimits,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    return ProviderInstanceLimits.of({
      markExhausted: (instanceId, resetAt) =>
        Effect.gen(function* () {
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          const parsed = resetAt ? Date.parse(resetAt) : Number.NaN;
          const untilMs = !Number.isFinite(parsed)
            ? nowMs + UNKNOWN_RESET_MS
            : Math.max(parsed, nowMs + STALE_RESET_MS);
          yield* Ref.update(state, (current) => {
            const next = new Map(current);
            next.set(instanceId, Math.max(untilMs, current.get(instanceId) ?? 0));
            return next;
          });
          return untilMs;
        }),
      exhaustedUntil: Ref.get(state),
    });
  }),
);

export const adapterCandidates = Effect.fnUntraced(function* (
  adapters: ProviderAdapterRegistryV2["Service"],
) {
  const getMetadata = adapters.getMetadata;
  if (getMetadata === undefined) return [];
  const ids = yield* adapters.list();
  const candidates: Array<ProviderFailoverCandidate & { readonly instanceId: ProviderInstanceId }> =
    [];
  for (const instanceId of ids) {
    const metadata = yield* Effect.option(getMetadata(instanceId));
    if (Option.isNone(metadata)) continue;
    candidates.push({
      instanceId,
      driver: metadata.value.driver,
      continuationGroupKey: metadata.value.continuationKey,
      available: metadata.value.enabled,
    });
  }
  return candidates;
});

/**
 * New turns on an instance that is out of usage go to a sibling that can
 * continue its sessions natively. Unchanged when the instance is fine or no
 * sibling has capacity.
 */
export const routeAroundExhaustedInstance = Effect.fn("UsageLimitFailover.route")(function* (
  selection: ModelSelection,
  limits: ProviderInstanceLimits["Service"],
  adapters: ProviderAdapterRegistryV2["Service"],
) {
  const exhaustedUntilMs = yield* limits.exhaustedUntil;
  const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
  if ((exhaustedUntilMs.get(selection.instanceId) ?? 0) <= nowMs) return selection;
  const target = pickProviderFailover({
    candidates: yield* adapterCandidates(adapters),
    currentInstanceId: selection.instanceId,
    exhaustedUntilMs,
    nowMs,
  });
  return target === null ? selection : { ...selection, instanceId: target.instanceId };
});
