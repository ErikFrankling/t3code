import {
  AttentionItem,
  AttentionItemId,
  AttentionItemListResult,
  AttentionItemResult,
  AttentionItemUpsertInput,
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
  "The Needs you list, shown beside the personal agent in T3 Code, holds only what the user alone can do: sign in somewhere, make a decision, answer a question. It is not a to-do list for agents.";

const AttentionItemUpsertTool = Tool.make("attention_item_upsert", {
  description: `${NEEDS_YOU} Add an item, or update the item with the same id. File one when your work is blocked on the user, list the threads that resume once it is done in unblocks, and keep working on anything that is not blocked. When the user ticks it, the personal agent is woken to check it and resume those threads. Updating an item keeps its done state.`,
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
  description: `${NEEDS_YOU} Mark an item done, reopen it, or dismiss it. Resolve items as soon as they stop needing the user, so the list stays current.`,
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
  description: `${NEEDS_YOU} List the items: open ones first by priority and age, then ones ticked in the last week.`,
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

export const AttentionToolkit = Toolkit.make(
  AttentionItemUpsertTool,
  AttentionItemResolveTool,
  AttentionItemListTool,
);
