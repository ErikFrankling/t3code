/**
 * A tapped "answer by voice" notification asks the thread's composer to start
 * dictating as soon as it is on screen. One pending request at a time; the
 * composer takes it once.
 */
let pending: string | null = null;
const listeners = new Set<() => void>();

export function requestLinkedDictation(threadKey: string) {
  pending = threadKey;
  for (const listener of listeners) listener();
}

/** True once, for the composer the request was for. */
export function takeLinkedDictation(threadKey: string): boolean {
  if (pending !== threadKey) return false;
  pending = null;
  return true;
}

export function subscribeLinkedDictation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
