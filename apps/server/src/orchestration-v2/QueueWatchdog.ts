import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Orchestrator from "./Orchestrator.ts";

/**
 * A queued message must start once its thread is idle. Run endings start the
 * queue directly; this sweep catches every path that leaves a thread idle
 * with messages waiting (a restart, a failed continuation, a limit that
 * reset, an account switch), and retries them.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("queue-watchdog", orchestrator.superviseQueues.pipe(Effect.asVoid));
  }),
);
