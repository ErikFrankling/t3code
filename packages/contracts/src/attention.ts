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
 * needs_you: something only the user can do, ticked by the user.
 * in_flight: work the personal agent has committed to and owns, closed only by
 * the agent and only with proof.
 */
export const AttentionItemKind = Schema.Literals(["needs_you", "in_flight"]);
export type AttentionItemKind = typeof AttentionItemKind.Type;

export const CommitmentState = Schema.Literals(["open", "in_progress", "waiting", "done"]).annotate(
  {
    description:
      "open: not started. in_progress: a thread is working on it. waiting: blocked on the user. done: finished and proven.",
  },
);
export type CommitmentState = typeof CommitmentState.Type;

export const AttentionItem = Schema.Struct({
  id: AttentionItemId,
  kind: AttentionItemKind,
  title: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String),
  unblocks: ForwardCompatibleArray(ThreadId),
  sourceThreadId: Schema.NullOr(ThreadId),
  priority: AttentionItemPriority,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  done: Schema.Boolean,
  doneAt: Schema.NullOr(IsoDateTime),
  /** In-flight items only; needs-you items mirror done. */
  state: CommitmentState,
  ownerThreadId: Schema.NullOr(ThreadId),
  proofRequired: Schema.NullOr(Schema.String),
  proof: Schema.NullOr(Schema.String),
  askedAt: Schema.NullOr(Schema.String),
  repeated: Schema.Boolean,
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
 * Open items first; in flight, repeated requests lead. Then by priority, then
 * oldest first so nothing ages out of view.
 */
export function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  if (left.done !== right.done) return left.done ? 1 : -1;
  if (!left.done && left.repeated !== right.repeated) return left.repeated ? -1 : 1;
  if (left.done && right.done) return (right.doneAt ?? "").localeCompare(left.doneAt ?? "");
  const rank = { high: 0, normal: 1, low: 2 } as const;
  return (
    rank[left.priority] - rank[right.priority] ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
