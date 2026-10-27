import { describe, expect, it, vi } from "vite-plus/test";

// No thread is mounted in these tests, so nothing is echoed yet.
vi.mock("./threads", () => ({ environmentThreadDetails: { threadAtom: () => ({}) } }));

import {
  acknowledgedThreadMessagesAtom,
  dropUndeliveredDictation,
  retainAcknowledgedThreadMessage,
  undeliveredReason,
} from "./acknowledged-thread-messages";
import { appAtomRegistry } from "./atom-registry";
import { threadComposerErrorsAtom } from "./thread-composer-error";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const message = (messageId: string, dictationId?: string) =>
  ({
    messageId,
    environmentId: "environment",
    threadId: "thread",
    text: dictationId ? `[dictation:${dictationId}]` : "typed",
    ...(dictationId ? { dictation: { id: dictationId, draft: "" } } : {}),
  }) as unknown as QueuedThreadMessage;

describe("a dictation the server will never post", () => {
  it("drops its Transcribing… row and tells the chat why", () => {
    appAtomRegistry.set(acknowledgedThreadMessagesAtom, []);
    retainAcknowledgedThreadMessage(message("typed-1"));
    retainAcknowledgedThreadMessage(message("dictated-1", "rec-1"));
    retainAcknowledgedThreadMessage(message("dictated-2", "rec-2"));

    dropUndeliveredDictation("rec-1", undeliveredReason({ delivery: "empty" }));

    expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom).map((m) => m.messageId)).toEqual([
      "typed-1",
      "dictated-2",
    ]);
    expect(appAtomRegistry.get(threadComposerErrorsAtom)["environment:thread"]?.message).toBe(
      "No speech was recognized, so nothing was sent. The recording is kept on your computer.",
    );
  });

  it("leaves everything alone for a dictation it does not know", () => {
    appAtomRegistry.set(acknowledgedThreadMessagesAtom, []);
    appAtomRegistry.set(threadComposerErrorsAtom, {});
    retainAcknowledgedThreadMessage(message("dictated-1", "rec-1"));

    dropUndeliveredDictation("rec-9", "unused");

    expect(appAtomRegistry.get(acknowledgedThreadMessagesAtom)).toHaveLength(1);
    expect(appAtomRegistry.get(threadComposerErrorsAtom)).toEqual({});
  });

  it("says why when the server gave up", () => {
    expect(undeliveredReason({ delivery: "abandoned", deliveryError: "thread deleted" })).toBe(
      "The dictation could not be sent: thread deleted. The recording is kept on your computer.",
    );
  });
});
