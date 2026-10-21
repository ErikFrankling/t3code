import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * Claude Code keeps each session's transcript in its own config directory
 * (`<configDir>/projects/<cwd-slug>/<sessionId>.jsonl`, plus a `<sessionId>/`
 * directory for subagent and tool-result sidecars). Every Claude instance on
 * this host shares one continuation group, so switching a thread to another
 * account resumes the same native session there; this copies the newest
 * transcript into the target config directory first.
 */
const knownClaudeConfigDirs = new Set<string>();

export const registerClaudeConfigDir = (configDir: string): void => {
  knownClaudeConfigDirs.add(configDir);
};

export const registeredClaudeConfigDirs = (): ReadonlyArray<string> => [...knownClaudeConfigDirs];

interface LocatedTranscript {
  readonly projectsDir: string;
  readonly slug: string;
  readonly mtimeMs: number;
}

const locateTranscript = Effect.fnUntraced(function* (configDir: string, nativeThreadId: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectsDir = path.join(configDir, "projects");
  const realProjectsDir = yield* fileSystem
    .realPath(projectsDir)
    .pipe(Effect.orElseSucceed(() => projectsDir));
  const slugs = yield* fileSystem
    .readDirectory(projectsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  let located: LocatedTranscript | undefined;
  for (const slug of slugs) {
    const info = yield* Effect.option(
      fileSystem.stat(path.join(projectsDir, slug, `${nativeThreadId}.jsonl`)),
    );
    if (Option.isNone(info) || info.value.type !== "File") continue;
    const mtimeMs = Option.match(info.value.mtime, {
      onNone: () => 0,
      onSome: (date) => date.getTime(),
    });
    if (located === undefined || mtimeMs > located.mtimeMs) {
      located = { projectsDir, slug, mtimeMs };
    }
  }
  return { realProjectsDir, located };
});

/**
 * Make `<configDir>` hold the newest copy of the session transcript found in
 * any of `candidateConfigDirs`. Directories whose `projects` resolves to the
 * same place (a shared symlink) are skipped. Returns whether anything was copied.
 */
export const syncClaudeSessionTranscript = Effect.fn("syncClaudeSessionTranscript")(
  function* (input: {
    readonly configDir: string;
    readonly nativeThreadId: string;
    readonly candidateConfigDirs: ReadonlyArray<string>;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // Native ids are UUIDs; anything else must not become a path segment.
    if (!/^[A-Za-z0-9_-]+$/.test(input.nativeThreadId)) return false;
    const own = yield* locateTranscript(input.configDir, input.nativeThreadId);
    let newest: LocatedTranscript | undefined;
    const seen = new Set([own.realProjectsDir]);
    for (const candidate of input.candidateConfigDirs) {
      const other = yield* locateTranscript(candidate, input.nativeThreadId);
      if (seen.has(other.realProjectsDir)) continue;
      seen.add(other.realProjectsDir);
      if (other.located !== undefined && other.located.mtimeMs > (newest?.mtimeMs ?? -1)) {
        newest = other.located;
      }
    }
    if (newest === undefined) return false;
    if (own.located !== undefined && own.located.mtimeMs >= newest.mtimeMs) return false;

    const fileName = `${input.nativeThreadId}.jsonl`;
    const targetDir = path.join(input.configDir, "projects", newest.slug);
    yield* fileSystem.makeDirectory(targetDir, { recursive: true });
    const temporary = path.join(targetDir, `.${fileName}.t3-sync`);
    yield* fileSystem.copyFile(path.join(newest.projectsDir, newest.slug, fileName), temporary);
    yield* fileSystem.rename(temporary, path.join(targetDir, fileName));
    const sidecar = path.join(newest.projectsDir, newest.slug, input.nativeThreadId);
    if (yield* fileSystem.exists(sidecar).pipe(Effect.orElseSucceed(() => false))) {
      yield* fileSystem.copy(sidecar, path.join(targetDir, input.nativeThreadId), {
        overwrite: true,
      });
    }
    return true;
  },
);
