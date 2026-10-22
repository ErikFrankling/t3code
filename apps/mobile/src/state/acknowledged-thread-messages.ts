import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import { scopedThreadKey } from "../lib/scopedEntities";
import { setThreadComposerError } from "./thread-composer-error";
import type { QueuedThreadMessage } from "./thread-outbox-model";

// A command acknowledgment can precede its message in the subscribed timeline.
// Keep the visible row until that projection arrives, independently of outbox cleanup.
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<QueuedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

export function retainAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    current.some((entry) => entry.messageId === message.messageId)
      ? current
      : [...current, message],
  );
}

export function forgetAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    current.filter((entry) => entry.messageId !== message.messageId),
  );
}

/** What the chat says when a sent dictation will never be posted. */
export function undeliveredReason(state: {
  readonly delivery?: string | undefined;
  readonly deliveryError?: string | undefined;
}): string {
  if (state.delivery === "empty") {
    return "No speech was recognized, so nothing was sent. The recording is kept on your computer.";
  }
  const detail = state.deliveryError ? `: ${state.deliveryError}.` : ".";
  return `The dictation could not be sent${detail} The recording is kept on your computer.`;
}

/**
 * A dictated message the server will never post (no speech was recognized, or
 * it gave up): its "Transcribing…" row goes, and the chat says why. The
 * recording stays on the server.
 */
export function dropUndeliveredDictation(dictationId: string, reason: string): void {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  const dropped = current.filter((message) => message.dictation?.id === dictationId);
  if (dropped.length === 0) return;
  appAtomRegistry.set(
    acknowledgedThreadMessagesAtom,
    current.filter((message) => message.dictation?.id !== dictationId),
  );
  for (const message of dropped) {
    setThreadComposerError(scopedThreadKey(message.environmentId, message.threadId), reason);
  }
}
