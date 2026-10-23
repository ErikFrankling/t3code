import * as Schema from "effect/Schema";

import {
  AttentionItemId,
  ForwardCompatibleArray,
  IsoDateTime,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Something only the user can do, such as signing in somewhere, making a
 * decision or answering a question, that blocks agent work until it is done.
 */
export const AttentionItemPriority = Schema.Literals(["high", "normal", "low"]).annotate({
  description: "How urgent the item is. high sorts first; normal is the default.",
});
export type AttentionItemPriority = typeof AttentionItemPriority.Type;

/**
 * The personal agent's to-do list, one markdown file per item in
 * `<baseDir>/personal/todo/` (finished ones in `todo/done/`). The files are the
 * only source; T3 Code shows them as one list.
 */
export const TodoStatus = Schema.Literals([
  "actionable",
  "in_flight",
  "blocked",
  "standing",
  "done",
]).annotate({
  description:
    "actionable: the agent can move it now. in_flight: a thread (owner) works on it. blocked: waits on blocked_on. standing: a permanent rule or goal. done: finished, with proof in the body.",
});
export type TodoStatus = typeof TodoStatus.Type;

/** Kept for the commitment tools' input; mapped onto TodoStatus. */
export const CommitmentState = Schema.Literals(["open", "in_progress", "waiting", "done"]).annotate({
  description:
    "open: not started. in_progress: a thread is working on it. waiting: blocked on the user. done: finished and proven.",
});
export type CommitmentState = typeof CommitmentState.Type;

export const AttentionItem = Schema.Struct({
  /** The file name without `.md`. */
  id: AttentionItemId,
  title: Schema.String,
  status: TodoStatus,
  /** erik | decision | time | external, when blocked. */
  blockedOn: Schema.NullOr(Schema.String),
  blockedUntil: Schema.NullOr(Schema.String),
  /** When the user asked, as written in the file (usually YYYY-MM-DD). */
  asked: Schema.NullOr(Schema.String),
  owner: Schema.NullOr(ThreadId),
  repeated: Schema.Number,
  /** The markdown after the front matter. */
  body: Schema.String,
  /** Set when the user ticked it; the personal agent verifies and changes the status. */
  erikTicked: Schema.NullOr(Schema.String),
  /** In `todo/done/`. */
  done: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type AttentionItem = typeof AttentionItem.Type;

export const AttentionItemListInput = Schema.Struct({});
export type AttentionItemListInput = typeof AttentionItemListInput.Type;

export const AttentionItemListResult = Schema.Struct({
  items: ForwardCompatibleArray(AttentionItem),
});
export type AttentionItemListResult = typeof AttentionItemListResult.Type;

export const AttentionItemUpsertInput = Schema.Struct({
  id: Schema.optional(
    AttentionItemId.annotate({
      description:
        "Stable id of the item, such as lastpass-login. Reuse it to update an item; omit it to create a new one.",
    }),
  ),
  title: TrimmedNonEmptyString.annotate({
    description: "Short imperative title, such as 'Sign in to LastPass in Agent Browser Login'.",
  }),
  detail: Schema.optional(
    Schema.NullOr(Schema.String).annotate({
      description: "Optional detail or link: what exactly to do and where.",
    }),
  ),
  unblocks: Schema.optional(
    Schema.Array(ThreadId).annotate({
      description: "Threads that can resume once the user has done this.",
    }),
  ),
  sourceThreadId: Schema.optional(
    Schema.NullOr(ThreadId).annotate({
      description: "Thread that filed the item. Defaults to the calling thread.",
    }),
  ),
  priority: Schema.optional(AttentionItemPriority),
});
export type AttentionItemUpsertInput = typeof AttentionItemUpsertInput.Type;

export const CommitmentUpsertInput = Schema.Struct({
  id: Schema.optional(
    AttentionItemId.annotate({
      description:
        "Stable id of the commitment, such as composer-grows. Reuse it to update; omit it to create.",
    }),
  ),
  title: TrimmedNonEmptyString.annotate({
    description: "What the user asked for, in a few words.",
  }),
  detail: Schema.optional(
    Schema.NullOr(Schema.String.annotate({ description: "The user's words or context." })),
  ),
  ownerThreadId: Schema.optional(
    Schema.NullOr(ThreadId.annotate({ description: "Thread doing the work." })),
  ),
  state: Schema.optional(CommitmentState),
  proofRequired: Schema.optional(
    Schema.NullOr(
      Schema.String.annotate({
        description: "What proof closes it, such as dark-theme screenshots at phone width.",
      }),
    ),
  ),
  askedAt: Schema.optional(
    Schema.NullOr(Schema.String.annotate({ description: "When the user asked, YYYY-MM-DD." })),
  ),
  repeated: Schema.optional(
    Schema.Boolean.annotate({ description: "The user had to ask again; it sorts first." }),
  ),
});
export type CommitmentUpsertInput = typeof CommitmentUpsertInput.Type;

export const AttentionItemResult = Schema.Struct({ item: AttentionItem });
export type AttentionItemResult = typeof AttentionItemResult.Type;

export const AttentionItemSetDoneInput = Schema.Struct({
  id: AttentionItemId,
  done: Schema.Boolean,
});
export type AttentionItemSetDoneInput = typeof AttentionItemSetDoneInput.Type;

export const AttentionItemDismissInput = Schema.Struct({ id: AttentionItemId });
export type AttentionItemDismissInput = typeof AttentionItemDismissInput.Type;

export const AttentionItemDismissResult = Schema.Struct({ id: AttentionItemId });
export type AttentionItemDismissResult = typeof AttentionItemDismissResult.Type;

export class AttentionItemError extends Schema.TaggedError<AttentionItemError>()(
  "AttentionItemError",
  {
    message: Schema.String,
    itemId: Schema.optional(AttentionItemId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Where an item shows in the one list, top to bottom:
 * needs_you (blocked on the user or a decision), moving (in flight or
 * actionable, including blocked items whose blocked_until has passed),
 * waiting (blocked on time or someone else), standing, done.
 */
export type TodoSection = "needs_you" | "moving" | "waiting" | "standing" | "done";
export const TODO_SECTIONS: ReadonlyArray<TodoSection> = [
  "needs_you",
  "moving",
  "waiting",
  "standing",
  "done",
];

export function todoSection(item: AttentionItem, now: number): TodoSection {
  if (item.done || item.status === "done") return "done";
  if (item.status === "standing") return "standing";
  if (item.status !== "blocked") return "moving";
  if (item.blockedOn === "erik" || item.blockedOn === "decision") return "needs_you";
  const until = item.blockedUntil === null ? Number.NaN : Date.parse(item.blockedUntil);
  return !Number.isNaN(until) && until <= now ? "moving" : "waiting";
}

/** True when the item waits on the user, so it gets a checkbox. */
export function todoNeedsUser(item: AttentionItem, now: number): boolean {
  return todoSection(item, now) === "needs_you";
}

/**
 * Repeated requests first, then in flight before actionable, then oldest asked
 * first so nothing ages out of view. Done items: most recently finished first.
 */
export function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  if (left.done !== right.done) return left.done ? 1 : -1;
  if (left.done) return right.updatedAt.localeCompare(left.updatedAt);
  if (left.repeated !== right.repeated) return right.repeated - left.repeated;
  const rank = { in_flight: 0, actionable: 1, blocked: 2, standing: 3, done: 4 } as const;
  return (
    rank[left.status] - rank[right.status] ||
    (left.asked ?? "9999").localeCompare(right.asked ?? "9999") ||
    left.id.localeCompare(right.id)
  );
}

export type TodoChipTone = "attention" | "active" | "waiting" | "muted" | "done";

/** The short state chip on a row. */
export function todoChip(
  item: AttentionItem,
  now: number,
): { readonly label: string; readonly tone: TodoChipTone } {
  const section = todoSection(item, now);
  if (section === "done") return { label: "Done", tone: "done" };
  if (section === "standing") return { label: "Standing", tone: "muted" };
  if (section === "needs_you") {
    if (item.erikTicked !== null) return { label: "Ticked, checking", tone: "active" };
    return { label: item.blockedOn === "decision" ? "Decide" : "Needs you", tone: "attention" };
  }
  if (section === "waiting") {
    if (item.blockedUntil !== null) {
      const until = Date.parse(item.blockedUntil);
      if (!Number.isNaN(until)) {
        const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
          until,
        );
        return { label: `Until ${day}`, tone: "waiting" };
      }
    }
    return {
      label: item.blockedOn === "time" ? "Waiting" : "Waiting on others",
      tone: "waiting",
    };
  }
  return item.status === "in_flight"
    ? { label: "In progress", tone: "active" }
    : { label: "Up next", tone: "active" };
}

/** How long ago the user asked, such as "today", "3d" or "2mo". */
export function todoAge(item: AttentionItem, now: number): string | null {
  const asked = item.asked === null ? Number.NaN : Date.parse(item.asked);
  if (Number.isNaN(asked)) return null;
  const days = Math.floor((now - asked) / 86_400_000);
  if (days < 1) return "today";
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}
