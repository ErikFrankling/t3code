import { useSyncExternalStore } from "react";

/**
 * What the environment's speech service has heard so far: the streaming
 * recogniser's live draft while recording, then the final recogniser's text.
 * Written by Android dictation (`voiceTranscription.android.ts`).
 */
export type DictationPreview = {
  readonly phase: "listening" | "refining";
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
      next.phase === current.phase &&
      next.draft === current.draft &&
      next.final === current.final)
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDictationPreview(): DictationPreview | null {
  return useSyncExternalStore(subscribe, () => current);
}
