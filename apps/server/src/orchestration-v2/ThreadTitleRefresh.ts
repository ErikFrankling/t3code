import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/**
 * Refreshes after the first three runs, then ever more rarely (5, 8, 12, 18, 27, ...): a busy
 * thread's title settles instead of flipping between paraphrases every few runs.
 */
export function isTitleRefreshRun(ordinal: number): boolean {
  if (ordinal < 1) return false;
  let next = 1;
  while (next < ordinal) next = next < 3 ? next + 1 : Math.ceil(next * 1.5);
  return next === ordinal;
}

const MIN_REFRESH_INTERVAL_MS = 10 * 60_000;

const comparable = (value: string): string =>
  value
    .toLocaleLowerCase()
    .replace(/(\.\.\.|…)\s*$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// The client seeds a title as the prompt's first 50 characters plus "..." (shared/String truncate).
const SEED_TRUNCATED_LENGTH = 53;

/** A title that is the start of the first message, as the client seeds it before a model names the thread. */
export function looksLikeSeedTitle(title: string, firstUserMessage: string | undefined): boolean {
  if (title.trim() === "New thread") return true;
  // Dictation seeds come from the live draft, so they need not match the delivered message.
  if (title.endsWith("...") && Array.from(title).length === SEED_TRUNCATED_LENGTH) return true;
  if (firstUserMessage === undefined) return false;
  const seed = comparable(title);
  return seed.length >= 8 && comparable(firstUserMessage).startsWith(seed);
}

export type TitleRefreshThread = Pick<
  OrchestrationV2AppThread,
  | "title"
  | "titleSource"
  | "titleRegeneration"
  | "archivedAt"
  | "deletedAt"
  | "lineage"
  | "createdBy"
  | "creationSource"
>;

/**
 * Whether T3 may rename a thread on its own. Explicit renames and titles the server gives at
 * creation (the personal agent) stay; titles cut from the first message, written by a model or
 * picked by an agent that launched the thread follow the conversation.
 */
export function titleRefreshAllowed(
  thread: TitleRefreshThread,
  firstUserMessage: () => string | undefined,
): boolean {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
  if (thread.lineage.relationshipToParent === "subagent") return false;
  if (thread.titleRegeneration != null) return false;
  switch (thread.titleSource) {
    case "seed":
    case "generated":
      return true;
    case "manual":
      return false;
    case undefined:
      return (
        (thread.createdBy === "agent" && thread.creationSource === "mcp") ||
        looksLikeSeedTitle(thread.title, firstUserMessage())
      );
  }
}

/**
 * Keeps auto-generated thread titles current: when a run completes, asks the title model to
 * re-title the thread from the whole conversation. The regenerate prompt keeps an accurate title.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const lastRefreshAt = new Map<ThreadId, number>();

  const firstUserMessage = Effect.fn("ThreadTitleRefresh.firstUserMessage")(function* (
    threadId: ThreadId,
  ) {
    const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
    const first = runs.reduce<(typeof runs)[number] | undefined>(
      (earliest, run) =>
        earliest === undefined || run.ordinal < earliest.ordinal ? run : earliest,
      undefined,
    );
    if (first === undefined) return undefined;
    const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
      messageIds: [first.userMessageId],
    });
    return messages[0]?.text;
  });

  const handle = Effect.fn("ThreadTitleRefresh.handle")(
    function* (event: OrchestrationV2DomainEvent) {
      if (event.type !== "run.updated" || event.payload.status !== "completed") return;
      if (!isTitleRefreshRun(event.payload.ordinal)) return;
      const threadId = event.threadId;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (nowMs - (lastRefreshAt.get(threadId) ?? 0) < MIN_REFRESH_INTERVAL_MS) return;
      const thread = yield* projections.getThread(threadId);
      const first =
        thread.titleSource === undefined ? yield* firstUserMessage(threadId) : undefined;
      if (!titleRefreshAllowed(thread, () => first)) return;
      lastRefreshAt.set(threadId, nowMs);
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        // One refresh per completed run, even across duplicate events.
        commandId: CommandId.make(`server:title-refresh:${threadId}:${event.payload.id}`),
        threadId,
        regenerateTitle: true,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread title refresh skipped", { threadId: event.threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("ThreadTitleRefresh.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread title refresh event stream failed", { cause }),
        ),
      ),
    );
  });
  return { start, handle };
});
