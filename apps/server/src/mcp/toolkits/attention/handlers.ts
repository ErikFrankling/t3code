import {
  type AttentionItem,
  type AttentionItemError,
  OrchestratorMcpFailure,
  todoNeedsUser,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as AttentionItemService from "../../../attention/AttentionItemService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AttentionToolkit } from "./tools.ts";

const toFailure = (error: AttentionItemError) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

const make = Effect.gen(function* () {
  const service = yield* AttentionItemService.AttentionItemService;
  const listWhere = (keep: (item: AttentionItem) => boolean) =>
    service.list().pipe(
      Effect.map(({ items }) => ({ items: items.filter(keep) })),
      Effect.mapError(toFailure),
    );
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
          yield* service.dismiss({ id: input.id });
          return { id: input.id, item: null };
        }
        const { item } = yield* service.setDone(
          { id: input.id, done: input.action === "done" },
          // Only the user's tick wakes the personal agent; an agent
          // resolving an item already knows about it.
          { wakePersonalAgent: false },
        );
        return { id: input.id, item };
      }).pipe(Effect.mapError(toFailure)),
    ),
    attention_item_list: McpToolAccess.reads(() =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        listWhere((item) => todoNeedsUser(item, now)),
      ),
    ),
    commitment_upsert: McpToolAccess.writesWithCapability((input) =>
      service.upsertCommitment(input).pipe(Effect.mapError(toFailure)),
    ),
    commitment_resolve: McpToolAccess.writesWithCapability((input) =>
      service.resolveCommitment(input).pipe(Effect.mapError(toFailure)),
    ),
    commitment_list: McpToolAccess.reads(() => listWhere(() => true)),
  } satisfies McpToolAccess.Handlers<typeof AttentionToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(AttentionToolkit, make);
