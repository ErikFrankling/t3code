import { useSyncExternalStore } from "react";

/**
 * Where the floating New thread button starts, in window coordinates, so the
 * dictation pill sits above it. The button floats over a native tab bar whose
 * height the pill cannot know, so the button reports its own measured top
 * (null while it is not shown).
 */
let fabTop: number | null = null;
const listeners = new Set<() => void>();

export function setFloatingButtonTop(top: number | null): void {
  if (top === fabTop) return;
  fabTop = top;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFloatingButtonTop(): number | null {
  return useSyncExternalStore(subscribe, () => fabTop);
}

/** The pill's `bottom` in a container whose bottom edge is at `containerBottom` in the window. */
export function pillBottomAbove(
  buttonTop: number | null,
  containerBottom: number,
  fallback: number,
  gap = 12,
): number {
  if (buttonTop === null) return fallback;
  return Math.max(fallback, containerBottom - buttonTop + gap);
}
