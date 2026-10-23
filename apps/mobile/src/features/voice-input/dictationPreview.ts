import { useSyncExternalStore } from "react";

/**
 * What the environment's speech service has heard so far, for the composer
 * that is dictating: the streaming recogniser's live draft and the final
 * recogniser's refined text, as in the web composer. Written by Android
 * dictation (`voiceTranscription.android.ts`).
 */
export type DictationPreview = {
  readonly ownerKey: string | null;
  /** `sent`: the message is queued with the server, which sends it when final. */
  readonly phase: "listening" | "refining" | "sent";
  readonly draft: string;
  readonly final: string;
};

let current: DictationPreview | null = null;
const listeners = new Set<() => void>();

export function setDictationPreview(next: DictationPreview | null): void {
  if (
    next === current ||
    (next &&
      current &&
      next.ownerKey === current.ownerKey &&
      next.phase === current.phase &&
      next.draft === current.draft &&
      next.final === current.final)
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

export function updateDictationPreview(update: Partial<Omit<DictationPreview, "ownerKey">>): void {
  if (current) setDictationPreview({ ...current, ...update });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDictationPreview(ownerKey: string | null): DictationPreview | null {
  const preview = useSyncExternalStore(subscribe, () => current);
  return preview && ownerKey !== null && preview.ownerKey === ownerKey ? preview : null;
}

export function getDictationPreview(): DictationPreview | null {
  return current;
}
