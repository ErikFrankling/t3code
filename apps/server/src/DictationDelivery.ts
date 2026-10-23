// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off -- The delivery loop outlives any request fiber and talks to the local speech server directly.
import {
  type DictationDeliverInput,
  type DictationTurn,
  DictationState,
  dictationMarker,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";
import * as ServerConfig from "./config.ts";
import {
  DictationDeliveryQueue,
  DictationRecordingUnavailable,
  dictationTurnThreadId,
} from "./DictationDeliveryQueue.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";

export const speechServiceUrl = () =>
  process.env.T3CODE_STT_URL ?? "http://127.0.0.1:8781/dictation";

const decodeDictationState = Schema.decodeUnknownSync(DictationState);

export class DictationDelivery extends Context.Service<DictationDelivery, DictationDeliveryQueue>()(
  "t3/DictationDelivery",
) {}

/** Why a turn cannot hold a recording; `undefined` when it can. */
export const invalidDictationTurn = (input: DictationDeliverInput): string | undefined => {
  if (!dictationTurnThreadId(input.turn)) return "A dictated message needs its target chat.";
  const text =
    input.turn.method === "launchThread"
      ? input.turn.input.initialMessage?.text
      : input.turn.command.type === "message.dispatch"
        ? input.turn.command.text
        : undefined;
  if (text?.split(dictationMarker(input.id)).length !== 2) return "Invalid dictation message.";
  return undefined;
};

// The same intake a typed send takes over the websocket, minus the analytics.
const deliverTurn = Effect.fn("DictationDelivery.deliverTurn")(function* (turn: DictationTurn) {
  if (turn.method === "dispatchCommand") {
    const command = turn.command;
    yield* ThreadMessageIntake.dispatchCommand(
      ThreadManagementService.withCreationProvenance(command, {
        createdBy: "user",
        creationSource: "creationSource" in command ? command.creationSource : "web",
      }),
    );
    return;
  }
  const input = turn.input;
  yield* ThreadMessageIntake.launchThread({
    commandId: input.commandId,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(input.reuseExistingThread === undefined
      ? {}
      : { reuseExistingThread: input.reuseExistingThread }),
    projectId: input.projectId,
    title: input.title,
    ...(input.generateTitle === undefined ? {} : { generateTitle: input.generateTitle }),
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    workspaceStrategy: input.workspaceStrategy,
    ...(input.initialMessage === undefined
      ? {}
      : {
          initialMessage: {
            ...(input.initialMessage.messageId === undefined
              ? {}
              : { messageId: input.initialMessage.messageId }),
            text: input.initialMessage.text,
            attachments: input.initialMessage.attachments,
            ...(input.initialMessage.context === undefined
              ? {}
              : { context: input.initialMessage.context }),
            ...(input.initialMessage.inputSource === undefined
              ? {}
              : { inputSource: input.initialMessage.inputSource }),
          },
        }),
    createdBy: "user",
    creationSource: input.creationSource ?? "web",
  });
});

export const layer = Layer.effect(
  DictationDelivery,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const intakeContext = yield* Effect.context<
      | ThreadManagementService.ThreadManagementService
      | ThreadLaunchService.ThreadLaunchService
      | FileSystem.FileSystem
      | ServerConfig.ServerConfig
      | ServerSettings.ServerSettingsService
    >();
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const queue = new DictationDeliveryQueue({
      directory: NodePath.join(config.stateDir, "dictation-deliveries"),
      speech: async (owner, id, action) => {
        const response = await fetch(speechServiceUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-STT-Owner": owner },
          body: JSON.stringify({ id, action }),
          signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 400 || response.status === 404)
          throw new DictationRecordingUnavailable(await response.text());
        if (!response.ok) throw new Error(`Speech service returned HTTP ${response.status}`);
        return decodeDictationState(await response.json());
      },
      dispatch: (turn) =>
        run(startup.enqueueCommand(deliverTurn(turn).pipe(Effect.provide(intakeContext)))),
      log: (event, fields) => {
        console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
      },
    });
    yield* Effect.promise(() => queue.start());
    yield* Effect.addFinalizer(() => Effect.promise(() => queue.close()));
    return queue;
  }),
);
