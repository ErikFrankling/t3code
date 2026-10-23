import {
  AttentionItem,
  AttentionItemId,
  AttentionItemListResult,
  AttentionItemResult,
  AttentionItemUpsertInput,
  CommitmentState,
  CommitmentUpsertInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as AttentionItemService from "../../../attention/AttentionItemService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  AttentionItemService.AttentionItemService,
];

const NEEDS_YOU =
  "T3 Code shows the personal agent's to-do list as one list: one markdown file per item in ~/.t3/personal/todo/ (format in todo/README.md; finished items in todo/done/). Items blocked on the user (status blocked, blocked_on erik or decision) are marked Needs you and sorted to the top. These tools write those files; the personal agent may also edit them directly. Use them only for what the user alone can do: sign in somewhere, make a decision, answer a question.";

const AttentionItemUpsertTool = Tool.make("attention_item_upsert", {
  description: `${NEEDS_YOU} Add an item that needs the user (todo/<id>.md with status blocked, blocked_on erik), or update the item with the same id. File one when your work is blocked on the user, put the exact step in detail and the threads that resume in unblocks, and keep working on anything that is not blocked. When the user ticks it, erik_ticked is recorded in the file and the personal agent is woken to verify it.`,
  parameters: AttentionItemUpsertInput,
  success: AttentionItemResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Add or update an attention item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AttentionItemResolveInput = Schema.Struct({
  id: AttentionItemId,
  action: Schema.Literals(["done", "reopen", "dismiss"]).annotate({
    description:
      "done: it is handled (does not wake anyone). reopen: put a ticked item back on the list, for example when it turned out not to be done. dismiss: remove it, for example when it no longer matters.",
  }),
});
export type AttentionItemResolveInput = typeof AttentionItemResolveInput.Type;

const AttentionItemResolveResult = Schema.Struct({
  id: AttentionItemId,
  item: Schema.NullOr(AttentionItem).annotate({
    description: "The item after the change; null once dismissed.",
  }),
});

const AttentionItemResolveTool = Tool.make("attention_item_resolve", {
  description: `${NEEDS_YOU} done moves the file to todo/done/; reopen puts it back as needing the user; dismiss moves it to done/ marked dismissed. Resolve items as soon as they stop needing the user, so the list stays current.`,
  parameters: AttentionItemResolveInput,
  success: AttentionItemResolveResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Resolve an attention item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AttentionItemListTool = Tool.make("attention_item_list", {
  description: `${NEEDS_YOU} List the to-do items that need the user now.`,
  success: AttentionItemListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List attention items")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const IN_FLIGHT =
  "These commitment tools write the same to-do files as attention_item_* (~/.t3/personal/todo/*.md): there is one list. open maps to status actionable, in_progress to in_flight, waiting to blocked (blocked_on erik). The user does not tick these; only the agent closes an item, and only with proof it looked at itself.";

const CommitmentUpsertTool = Tool.make("commitment_upsert", {
  description: `${IN_FLIGHT} Add a commitment, or update the one with the same id: title, the user's words in detail, the owner thread, state (open, in_progress, waiting), the proof that will close it, the date asked, and repeated when the user had to ask again. Record every request in the turn it is made. Close it with commitment_resolve.`,
  parameters: CommitmentUpsertInput,
  success: AttentionItemResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Add or update a commitment")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CommitmentResolveInput = Schema.Struct({
  id: AttentionItemId,
  state: CommitmentState,
  proof: Schema.optional(
    Schema.NullOr(
      Schema.String.annotate({
        description:
          "Required for done: screenshot paths, a log excerpt, test output or a link you checked yourself.",
      }),
    ),
  ),
});

const CommitmentResolveTool = Tool.make("commitment_resolve", {
  description: `${IN_FLIGHT} Move a commitment to another state. done needs proof and fails without it.`,
  parameters: CommitmentResolveInput,
  success: AttentionItemResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Resolve a commitment")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CommitmentListTool = Tool.make("commitment_list", {
  description: `${IN_FLIGHT} List the whole to-do list: open items (repeated ones first), then items finished in the last week.`,
  success: AttentionItemListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List commitments")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const AttentionToolkit = Toolkit.make(
  AttentionItemUpsertTool,
  AttentionItemResolveTool,
  AttentionItemListTool,
  CommitmentUpsertTool,
  CommitmentResolveTool,
  CommitmentListTool,
);
