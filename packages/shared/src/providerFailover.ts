/**
 * Provider instances that continue each other's native sessions (for example
 * two Claude accounts on one machine) share a driver and continuation group.
 * When one hits its usage limit, a thread moves to a sibling and keeps its
 * full conversation.
 */
export interface ProviderFailoverCandidate {
  readonly instanceId: string;
  readonly driver: string;
  readonly continuationGroupKey: string | undefined;
  /** Enabled and not in an error state. */
  readonly available: boolean;
}

export function providerContinuationSiblings<T extends ProviderFailoverCandidate>(
  candidates: ReadonlyArray<T>,
  currentInstanceId: string,
): ReadonlyArray<T> {
  const current = candidates.find((candidate) => candidate.instanceId === currentInstanceId);
  const groupKey = current?.continuationGroupKey;
  if (current === undefined || groupKey === undefined) return [];
  return candidates.filter(
    (candidate) =>
      candidate.instanceId !== currentInstanceId &&
      candidate.driver === current.driver &&
      candidate.continuationGroupKey === groupKey &&
      candidate.available,
  );
}

/**
 * The sibling to continue on, skipping instances whose limit has not reset
 * yet. Null when every sibling is exhausted or there is none.
 */
export function pickProviderFailover<T extends ProviderFailoverCandidate>(input: {
  readonly candidates: ReadonlyArray<T>;
  readonly currentInstanceId: string;
  readonly exhaustedUntilMs: ReadonlyMap<string, number>;
  readonly nowMs: number;
}): T | null {
  const siblings = providerContinuationSiblings(input.candidates, input.currentInstanceId);
  return (
    siblings.find(
      (candidate) => (input.exhaustedUntilMs.get(candidate.instanceId) ?? 0) <= input.nowMs,
    ) ?? null
  );
}
