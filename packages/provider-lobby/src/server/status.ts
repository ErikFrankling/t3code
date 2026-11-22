import {
  type ModelCapabilities,
  type ServerProviderModel,
  type ServerProviderAuth,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  buildSelectOptionDescriptor,
  isCommandMissingCause,
  providerModelsFromSettings,
  providerProbeEnvironment,
  resolveProviderProbeTimeoutMs,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { LOBBY_API_KEY_ENV } from "../client.ts";
import type { LobbySettings } from "../settings.ts";

const LOBBY_PRESENTATION = {
  displayName: "Lobby",
  showInteractionModeToggle: false,
  // Lobby agents run in their own cloud sandbox with no approvals.
  supportedRuntimeModes: ["full-access"],
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** `lobby acp check`: the CLI version, the key's account and the models a chat can use. */
const LobbyCheck = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.optional(Schema.NullOr(Schema.String)),
    email: Schema.NullOr(Schema.String),
    models: Schema.Array(
      Schema.Struct({
        value: Schema.String,
        name: Schema.String,
        source: Schema.NullOr(Schema.String),
        reasoningEfforts: Schema.Array(Schema.String),
        defaultReasoningEffort: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const decodeLobbyCheck = Schema.decodeUnknownOption(LobbyCheck);

/**
 * Lobby's models as T3 models. The slug is `lobby acp`'s `adapter:id` value, so the
 * same model on two harnesses stays two choices; `effort` is `lobby acp`'s option id.
 */
export function lobbyModelsFromCheck(
  stdout: string,
): ReadonlyArray<ServerProviderModel> | undefined {
  const check = Option.getOrUndefined(decodeLobbyCheck(stdout.trim()));
  if (check === undefined) return undefined;
  return check.models.map((model, index) => ({
    slug: model.value,
    name: model.source ? `${model.name} (${model.source})` : model.name,
    isCustom: false,
    ...(index === 0 ? { isDefault: true } : {}),
    capabilities:
      model.reasoningEfforts.length === 0
        ? EMPTY_CAPABILITIES
        : createModelCapabilities({
            optionDescriptors: [
              buildSelectOptionDescriptor({
                id: "effort",
                label: "Reasoning",
                options: model.reasoningEfforts.map((level) => ({
                  value: level,
                  label: EFFORT_LABELS[level] ?? level,
                  isDefault: level === (model.defaultReasoningEffort ?? "medium"),
                })),
              }),
            ],
          }),
  }));
}

/** The CLI version `lobby acp check` reports (older CLIs report none). */
export function lobbyVersionFromCheck(stdout: string): string | null {
  return Option.getOrUndefined(decodeLobbyCheck(stdout.trim()))?.version ?? null;
}

export function lobbyAuthFromCheck(stdout: string): ServerProviderAuth {
  const check = Option.getOrUndefined(decodeLobbyCheck(stdout.trim()));
  return {
    status: "authenticated",
    type: "api_key",
    label: "Lobby API key",
    ...(check?.email ? { email: check.email } : {}),
  };
}

const snapshot = (
  settings: LobbySettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed: ReadonlyArray<ServerProviderModel> = [],
) =>
  buildServerProvider({
    presentation: LOBBY_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(listed, settings.customModels, EMPTY_CAPABILITIES),
    probe,
  });

export const buildInitialLobbyProviderSnapshot = Effect.fn(
  "LobbyProvider.buildInitialLobbyProviderSnapshot",
)(function* (settings: LobbySettings): Effect.fn.Return<ServerProviderDraft> {
  const now = yield* DateTime.now;
  return snapshot(settings, DateTime.formatIso(now), {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled ? "Checking Lobby…" : "Lobby is disabled in T3 Code settings.",
  });
});

/** The CLI's own error sentence (`lobby: …`), which names the next step and never a key. */
const cliMessage = (stderr: string) =>
  stderr
    .split("\n")
    .map((line) => line.replace(/^lobby: /, "").trim())
    .find((line) => line.length > 0);

export const checkLobbyProviderStatus = Effect.fn("checkLobbyProviderStatus")(function* (
  settings: LobbySettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Lobby is disabled in T3 Code settings.",
    });
  }
  if (!environment[LOBBY_API_KEY_ENV]?.trim() && !environment.LOBBY_API_KEY_FILE?.trim()) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Add your Lobby API key in this provider's settings.",
    });
  }
  const command = settings.binaryPath || "lobby";
  const args = ["acp", "check", ...(settings.site ? ["--site", settings.site] : [])];
  const probeEnvironment = providerProbeEnvironment(environment);
  const result = yield* resolveSpawnCommand(command, args, { env: probeEnvironment }).pipe(
    Effect.flatMap((spawn) =>
      spawnAndCollect(
        command,
        ChildProcess.make(spawn.command, spawn.args, { env: probeEnvironment, shell: spawn.shell }),
      ),
    ),
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("lobby", AUTH_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(result) || Option.isNone(result.success)) {
    const missing = Result.isFailure(result) && isCommandMissingCause(result.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "The Lobby CLI (`lobby`) is not installed or not on PATH. Install it with `npm install --global @abloatai/lobby`."
        : "Lobby did not answer in time. Check your connection to Lobby.",
    });
  }
  const output = result.success.value;
  const models = output.code === 0 ? lobbyModelsFromCheck(output.stdout) : undefined;
  if (models === undefined) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: /API key/i.test(output.stderr) ? "unauthenticated" : "unknown" },
      message:
        cliMessage(output.stderr) ??
        "The Lobby CLI could not read your account. Update it and try again.",
    });
  }
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version: lobbyVersionFromCheck(output.stdout),
      status: models.length > 0 ? "ready" : "warning",
      auth: lobbyAuthFromCheck(output.stdout),
      ...(models.length > 0
        ? {}
        : { message: "No models are connected in Lobby. Connect one in Lobby settings." }),
    },
    models,
  );
});
