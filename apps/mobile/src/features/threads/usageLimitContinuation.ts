import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { providerContinuationSiblings } from "@t3tools/shared/providerFailover";

export interface UsageLimitContinuationTarget {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

/**
 * Other instances that continue the same native session (for example a second
 * Claude account), so a thread stopped by one account's usage limit can carry
 * on with the full conversation on another.
 */
export function usageLimitContinuationTargets(
  providers: ReadonlyArray<ServerProvider>,
  currentInstanceId: ProviderInstanceId,
): ReadonlyArray<UsageLimitContinuationTarget> {
  return providerContinuationSiblings(
    providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      continuationGroupKey: provider.continuation?.groupKey,
      available: provider.enabled && provider.status !== "error" && provider.status !== "disabled",
      provider,
    })),
    currentInstanceId,
  ).map(({ provider }) => ({
    instanceId: provider.instanceId,
    label: provider.displayName ?? provider.instanceId,
  }));
}
