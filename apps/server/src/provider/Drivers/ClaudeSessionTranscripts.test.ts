import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { syncClaudeSessionTranscript } from "./ClaudeSessionTranscripts.ts";

const sessionId = "0f9e3c1a-1111-4222-8333-444455556666";
const slug = "-home-erik-project";

const makeHomes = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-transcripts-" });
  const first = path.join(root, ".claude");
  const second = path.join(root, ".claude_2");
  yield* fileSystem.makeDirectory(path.join(first, "projects", slug), { recursive: true });
  yield* fileSystem.makeDirectory(second, { recursive: true });
  const transcript = (home: string) => path.join(home, "projects", slug, `${sessionId}.jsonl`);
  const writeTranscript = (home: string, content: string, mtimeSeconds: number) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(transcript(home)), { recursive: true });
      yield* fileSystem.writeFileString(transcript(home), content);
      yield* fileSystem.utimes(transcript(home), mtimeSeconds, mtimeSeconds);
    });
  return { fileSystem, path, root, first, second, transcript, writeTranscript };
});

it.layer(NodeServices.layer)("ClaudeSessionTranscripts", (it) => {
  describe("syncClaudeSessionTranscript", () => {
    it.effect("copies the transcript and its sidecars to the other account and back", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fileSystem, path, first, second, transcript, writeTranscript } = yield* makeHomes;
          yield* writeTranscript(first, "turn 1\n", 1_000);
          const sidecar = path.join(first, "projects", slug, sessionId, "subagents");
          yield* fileSystem.makeDirectory(sidecar, { recursive: true });
          yield* fileSystem.writeFileString(path.join(sidecar, "agent-a.jsonl"), "child\n");

          expect(
            yield* syncClaudeSessionTranscript({
              configDir: second,
              nativeThreadId: sessionId,
              candidateConfigDirs: [first],
            }),
          ).toBe(true);
          expect(yield* fileSystem.readFileString(transcript(second))).toBe("turn 1\n");
          expect(
            yield* fileSystem.readFileString(
              path.join(second, "projects", slug, sessionId, "subagents", "agent-a.jsonl"),
            ),
          ).toBe("child\n");

          // A turn on the other account makes its copy the newest.
          yield* writeTranscript(second, "turn 1\nturn 2\n", 4_000_000_000);
          expect(
            yield* syncClaudeSessionTranscript({
              configDir: first,
              nativeThreadId: sessionId,
              candidateConfigDirs: [second],
            }),
          ).toBe(true);
          expect(yield* fileSystem.readFileString(transcript(first))).toBe("turn 1\nturn 2\n");
        }),
      ),
    );

    it.effect("keeps a newer local transcript and skips shared projects directories", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fileSystem, path, root, first, second, transcript, writeTranscript } =
            yield* makeHomes;
          yield* writeTranscript(first, "stale\n", 1_000);
          yield* writeTranscript(second, "newest\n", 2_000);
          expect(
            yield* syncClaudeSessionTranscript({
              configDir: second,
              nativeThreadId: sessionId,
              candidateConfigDirs: [first],
            }),
          ).toBe(false);
          expect(yield* fileSystem.readFileString(transcript(second))).toBe("newest\n");

          const linked = path.join(root, ".claude_3");
          yield* fileSystem.makeDirectory(linked);
          yield* fileSystem.symlink(path.join(first, "projects"), path.join(linked, "projects"));
          expect(
            yield* syncClaudeSessionTranscript({
              configDir: linked,
              nativeThreadId: sessionId,
              candidateConfigDirs: [first],
            }),
          ).toBe(false);
          expect(
            yield* syncClaudeSessionTranscript({
              configDir: second,
              nativeThreadId: "../escape",
              candidateConfigDirs: [first],
            }),
          ).toBe(false);
        }),
      ),
    );
  });
});
