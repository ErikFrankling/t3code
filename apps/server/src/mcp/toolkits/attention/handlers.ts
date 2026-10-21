import { type AttentionItemError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as AttentionItemService from "../../../attention/AttentionItemService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AttentionToolkit } from "./tools.ts";

const toFailure = (error: AttentionItemError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const make = Effect.gen(function* () {
  const service = yield* AttentionItemService.AttentionItemService;
  return {
    attention_item_upsert: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        return yield* service
          .upsert(input, { threadId: scope.thread?.threadId ?? null })
          .pipe(Effect.mapError(toFailure));
      }),
    ),
    attention_item_resolve: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        if (input.action === "dismiss") {
          yield* service.dismiss({ id: input.id }).pipe(Effect.mapError(toFailure));
          return { id: input.id, item: null };
        }
        const { item } = yield* service
          .setDone(
            { id: input.id, done: input.action === "done" },
            // Only the user's tick wakes the personal agent; an agent
            // resolving an item already knows about it.
            { wakePersonalAgent: false },
          )
          .pipe(Effect.mapError(toFailure));
        return { id: input.id, item };
      }),
    ),
    attention_item_list: McpToolAccess.reads(() => service.list().pipe(Effect.mapError(toFailure))),
  } satisfies McpToolAccess.Handlers<typeof AttentionToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(AttentionToolkit, make);
