import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { ProviderDriverKind, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { LobbySettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

export const LOBBY_PROVIDER = ProviderDriverKind.make("lobby");
const DEFAULT_LOBBY_SETTINGS = Schema.decodeSync(LobbySettings)({});

/**
 * A Lobby chat runs in Lobby's cloud sandbox with no approvals, so T3 sees no
 * permission requests and cannot roll a chat back. Model and effort apply when
 * the chat starts; the public API has no model switch for a running chat.
 */
const LobbyProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
  approvals: {
    ...AcpProviderCapabilitiesV2.approvals,
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

type LobbyAcpRuntimeSettings = Pick<LobbySettings, "binaryPath" | "site" | "repositoryId">;

/** `lobby acp`: the Lobby CLI's ACP agent, one Lobby chat per ACP session. */
export function buildLobbyAcpSpawnInput(
  settings: LobbyAcpRuntimeSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "lobby",
    args: [
      "acp",
      ...(settings.site ? ["--site", settings.site] : []),
      ...(settings.repositoryId ? ["--repository", settings.repositoryId] : []),
    ],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

export interface LobbyAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: LobbyAcpRuntimeSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeLobbyAcpRuntime = Effect.fn("LobbyAcpSupport.makeLobbyAcpRuntime")(function* (
  input: LobbyAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { settings, environment, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: buildLobbyAcpSpawnInput(settings, input.cwd, environment),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** `lobby acp` answers a failed prompt with a sentence meant for the user (a key, model or limit problem). */
function lobbyPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause) ? { message: cause.errorMessage, code: String(cause.code) } : {}),
    class: "provider_error",
  });
}

export interface LobbyAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: LobbySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
}

function makeLobbyAcpAdapterFlavor(options: LobbyAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: LOBBY_PROVIDER,
    runtimeHarness: "Lobby",
    capabilities: LobbyProviderCapabilitiesV2,
    makeRuntime: (input: AcpAdapterV2RuntimeInput) => {
      const { runtimePolicy: _runtimePolicy, processEnvironment, ...runtimeInput } = input;
      return makeLobbyAcpRuntime({
        ...runtimeInput,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
      });
    },
    promptFailure: lobbyPromptFailure,
  };
}

export const makeLobbyAdapterV2 = Effect.fn("makeLobbyAdapterV2")(function* (
  options: LobbyAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeLobbyAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type LobbyAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeLobbyAdapterV2Driver = (): ProviderAdapterDriver<
  LobbySettings,
  LobbyAdapterV2DriverEnv
> => ({
  driverKind: LOBBY_PROVIDER,
  configSchema: LobbySettings,
  defaultConfig: (): LobbySettings => DEFAULT_LOBBY_SETTINGS,
  create: Effect.fn("LobbyAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<LobbySettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeLobbyAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: LOBBY_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: LOBBY_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Lobby ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
