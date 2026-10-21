import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  CLAUDE_HOST_CONTINUATION_KEY,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect(
      "shares continuation across all Claude homes unless a group names them apart, without sharing account state",
      () =>
        Effect.gen(function* () {
          const first = {
            binaryPath: "claude",
            homePath: "~/.claude",
            sharedSessionGroup: " max ",
          };
          const second = { ...first, homePath: "~/.claude_2", sharedSessionGroup: "max" };
          const key = yield* makeClaudeContinuationGroupKey(first);
          expect(key).toBe("claude:shared:max");
          expect(yield* makeClaudeContinuationGroupKey(second)).toBe(key);
          expect(
            yield* makeClaudeContinuationGroupKey({ ...second, sharedSessionGroup: "other" }),
          ).not.toBe(key);
          expect(
            yield* makeClaudeContinuationGroupKey({ ...second, sharedSessionGroup: "" }),
          ).not.toBe(key);
          expect(
            yield* makeClaudeContinuationGroupKey({ ...second, sharedSessionGroup: "   " }),
          ).toBe(CLAUDE_HOST_CONTINUATION_KEY);
          expect(yield* makeClaudeContinuationGroupKey({ homePath: second.homePath })).toBe(
            yield* makeClaudeContinuationGroupKey({ homePath: first.homePath }),
          );
          expect(yield* makeClaudeEnvironment(first)).not.toEqual(
            yield* makeClaudeEnvironment(second),
          );
          expect(yield* makeClaudeCapabilitiesCacheKey(first)).not.toBe(
            yield* makeClaudeCapabilitiesCacheKey(second),
          );
        }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(
          CLAUDE_HOST_CONTINUATION_KEY,
        );
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          CLAUDE_HOST_CONTINUATION_KEY,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
