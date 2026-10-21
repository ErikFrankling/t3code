import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

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
  const current = providers.find((provider) => provider.instanceId === currentInstanceId);
  const groupKey = current?.continuation?.groupKey;
  if (current === undefined || groupKey === undefined) return [];
  return providers
    .filter(
      (provider) =>
        provider.instanceId !== currentInstanceId &&
        provider.driver === current.driver &&
        provider.continuation?.groupKey === groupKey &&
        provider.enabled &&
        provider.status !== "error" &&
        provider.status !== "disabled",
    )
    .map((provider) => ({
      instanceId: provider.instanceId,
      label: provider.displayName ?? provider.instanceId,
    }));
}
