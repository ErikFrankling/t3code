/**
 * Lobby instance settings. Shared by the server driver and the client
 * settings form, so it holds only browser-safe schema code.
 *
 * @module provider-lobby/settings
 */
import {
  CustomModelSetting,
  TrimmedString,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const LOBBY_DEFAULT_SITE = "https://lobby.abloatai.com";

export const LobbySettings = makeProviderSettingsSchema(
  {
    // Off by default: users opt in from Settings once they have a Lobby API key.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("lobby").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Lobby CLI (`npm install --global @abloatai/lobby`).",
        providerSettingsForm: { placeholder: "lobby", clearWhenEmpty: "omit" },
      }),
    ),
    site: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed(LOBBY_DEFAULT_SITE)),
      Schema.annotateKey({
        title: "Lobby URL",
        description: "The Lobby your API key belongs to.",
        providerSettingsForm: { placeholder: LOBBY_DEFAULT_SITE, clearWhenEmpty: "omit" },
      }),
    ),
    repositoryId: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Repository ID",
        description:
          "Optional. The GitHub repository ID every chat runs on. Empty, each chat runs on the project folder's GitHub origin.",
        providerSettingsForm: { placeholder: "From the project folder", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["site", "repositoryId", "binaryPath"],
  },
);
export type LobbySettings = typeof LobbySettings.Type;
