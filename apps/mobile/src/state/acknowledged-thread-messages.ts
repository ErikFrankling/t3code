import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import { threadHasCaughtUpTo } from "@t3tools/client-runtime/state/threads";
import { scopedThreadKey } from "../lib/scopedEntities";
import { setThreadComposerError } from "./thread-composer-error";
import type { AcknowledgedThreadMessage, QueuedThreadMessage } from "./thread-outbox-model";
import { environmentThreadDetails } from "./threads";

// Keep acknowledged rows until the thread catches up; command receipts can precede messages.
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<AcknowledgedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

// Peeks at a thread only when something already has it in the registry: reading
// it through the registry would open a snapshot load and a live stream of its own.
function isEchoedInMountedThread(message: AcknowledgedThreadMessage): boolean {
  const stateAtom = environmentThreadDetails.stateAtom({
    environmentId: message.environmentId,
    threadId: message.threadId,
  });
  const node = appAtomRegistry.getNodes().get(stateAtom);
  if (node === undefined) return false;
  const loaded: Option.Option<Atom.Type<typeof stateAtom>> = node.valueOption();
  return Option.match(loaded, {
    onNone: () => false,
    onSome: (thread) =>
      threadHasCaughtUpTo(message, {
        sequence: thread.sequence,
        messages: Option.getOrUndefined(thread.data)?.messages,
      }),
  });
}

function writeAcknowledgedThreadMessages(
  update: (
    current: ReadonlyArray<AcknowledgedThreadMessage>,
  ) => ReadonlyArray<AcknowledgedThreadMessage>,
) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  const next = update(current).filter((entry) => !isEchoedInMountedThread(entry));
  if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
    return;
  }
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, next);
}

export function retainAcknowledgedThreadMessage(message: AcknowledgedThreadMessage) {
  writeAcknowledgedThreadMessages((current) =>
    current.some((entry) => entry.messageId === message.messageId)
      ? current
      : [...current, message],
  );
}

export function forgetAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  writeAcknowledgedThreadMessages((current) =>
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
