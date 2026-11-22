import { assert, describe, it } from "@effect/vitest";

import { buildLobbyAcpSpawnInput } from "./adapter.ts";
import { lobbyModelsFromCheck, lobbyVersionFromCheck } from "./status.ts";

describe("Lobby provider", () => {
  it("lists `lobby acp check` models by their ACP value with Lobby's effort levels", () => {
    const check = JSON.stringify({
      site: "https://lobby.example.com",
      version: "0.1.2",
      email: "dev@example.com",
      accountId: "ws-1",
      models: [
        {
          value: "claude:claude-opus-5-5",
          name: "Claude Opus 5.5",
          source: "Claude subscription",
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
        },
        {
          value: "codex:gpt-6-astra",
          name: "GPT-6 Astra",
          source: null,
          reasoningEfforts: [],
          defaultReasoningEffort: null,
        },
      ],
    });
    const models = lobbyModelsFromCheck(check);
    assert.deepStrictEqual(
      models?.map((model) => [model.slug, model.name, model.isDefault === true]),
      [
        ["claude:claude-opus-5-5", "Claude Opus 5.5 (Claude subscription)", true],
        ["codex:gpt-6-astra", "GPT-6 Astra", false],
      ],
    );
    const effort = models?.[0]?.capabilities?.optionDescriptors?.[0];
    assert.strictEqual(effort?.id, "effort");
    assert.strictEqual(lobbyVersionFromCheck(check), "0.1.2");
    assert.strictEqual(lobbyModelsFromCheck("lobby: not json"), undefined);
  });

  it("starts `lobby acp` on the configured Lobby and repository", () => {
    assert.deepStrictEqual(
      buildLobbyAcpSpawnInput(
        { binaryPath: "", site: "https://dev.lobby.example.com", repositoryId: "42" },
        "/work",
      ),
      {
        command: "lobby",
        args: ["acp", "--site", "https://dev.lobby.example.com", "--repository", "42"],
        cwd: "/work",
      },
    );
  });
});
