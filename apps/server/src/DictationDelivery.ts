import { makeBootstrapTurnDispatcher } from "./orchestration/BootstrapTurn.ts";
import { DictationState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { join } from "node:path";
import { DictationDeliveryQueue } from "./DictationDeliveryQueue.ts";
import { ServerConfig } from "./config.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ServerRuntimeStartup } from "./serverRuntimeStartup.ts";

export class DictationDelivery extends Context.Service<DictationDelivery, DictationDeliveryQueue>()(
  "t3/DictationDelivery",
) {}
export const dictationDeliveryLayer = Layer.effect(
  DictationDelivery,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const engine = yield* OrchestrationEngineService;
    const startup = yield* ServerRuntimeStartup;
    const bootstrap = yield* makeBootstrapTurnDispatcher(engine.dispatch, true);
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const queue = new DictationDeliveryQueue({
      directory: join(config.stateDir, "dictation-deliveries"),
      speech: async (owner, id, action) => {
        const response = await fetch(
          process.env.T3CODE_STT_URL ?? "http://127.0.0.1:8781/dictation",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-STT-Owner": owner },
            body: JSON.stringify({ id, action }),
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (!response.ok) throw new Error(`Speech service returned HTTP ${response.status}`);
        return Schema.decodeUnknownSync(DictationState)(await response.json());
      },
      dispatch: (command) => run(startup.enqueueCommand(bootstrap(command))),
      log: (event, fields) => {
        console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
      },
    });
    yield* Effect.promise(() => queue.start());
    yield* Effect.addFinalizer(() => Effect.promise(() => queue.close()));
    return queue;
  }),
);
