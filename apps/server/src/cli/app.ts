// @effect-diagnostics globalTimers:off -- The Node socket client owns its response deadline and clears it on every completion path.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect stat follows symlinks; IPC ownership validation requires lstat.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationErrorCode,
  DesktopAppControlResponse,
  type DesktopAppControlRequest,
  type DesktopSpeakReplyRequest,
  DesktopSpeakReplyStatus,
  SPEAK_REPLY_MAX_TEXT_LENGTH,
  type DesktopAppActivationPlatform,
  type DesktopAppActivationRequest,
  ThreadId,
} from "@t3tools/contracts";
import {
  resolveDesktopAppControlAddress,
  type DesktopAppControlAddress,
} from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const CLI_RESPONSE_TIMEOUT_MS = 17_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const isDesktopAppControlResponse = Schema.is(DesktopAppControlResponse);
const isDesktopAppActivationErrorCode = Schema.is(DesktopAppActivationErrorCode);
const encodeSpeakReplyStatus = Schema.encodeSync(Schema.fromJsonString(DesktopSpeakReplyStatus));

export class DesktopAppSshUnsupportedError extends Schema.TaggedError<DesktopAppSshUnsupportedError>()(
  "DesktopAppSshUnsupportedError",
  {},
) {
  override get message(): string {
    return "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH.";
  }
}

export class DesktopAppPlatformUnsupportedError extends Schema.TaggedError<DesktopAppPlatformUnsupportedError>()(
  "DesktopAppPlatformUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `\`t3 app\` is not supported on ${this.platform}.`;
  }
}

export class DesktopAppUnreachableError extends Schema.TaggedError<DesktopAppUnreachableError>()(
  "DesktopAppUnreachableError",
  {
    candidateAddresses: Schema.Array(Schema.String),
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not reach the T3 Code desktop app. Start or update the desktop app on this machine, then run `t3 app` again. A running T3 Code server is not enough.";
  }
}

export class DesktopAppRequestFailedError extends Schema.TaggedError<DesktopAppRequestFailedError>()(
  "DesktopAppRequestFailedError",
  {
    code: DesktopAppActivationErrorCode,
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `T3 Code could not open ${this.workspaceRoot} (${this.code}).`;
  }
}

function isDesktopPlatform(platform: NodeJS.Platform): platform is DesktopAppActivationPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

async function sendDesktopAppActivationRequest(input: {
  readonly address: DesktopAppControlAddress;
  readonly fallbackAddress?: DesktopAppControlAddress;
  readonly userId: number | undefined;
  readonly request: DesktopAppControlRequest;
  readonly timeoutMs?: number;
}): Promise<DesktopAppControlResponse> {
  if (input.address.directory !== null) {
    const stat = await NodeFSP.lstat(input.address.directory);
    if (
      !stat.isDirectory() ||
      input.userId === undefined ||
      stat.uid !== input.userId ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("The desktop app socket directory is not private or owned by this user.");
    }
  }
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(input.address.address);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let connected = false;

    const finish = (
      result:
        | { readonly type: "success"; readonly response: DesktopAppControlResponse }
        | { readonly type: "failure"; readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (result.type === "success") resolve(result.response);
      else reject(result.error);
    };

    const timeout = setTimeout(() => {
      finish({
        type: "failure",
        error: new Error("The desktop app did not respond in time."),
      });
    }, input.timeoutMs ?? CLI_RESPONSE_TIMEOUT_MS);

    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(input.request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish({ type: "failure", error: new Error("The desktop app response is too large.") });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish({
          type: "failure",
          error: new Error("The desktop app response is not valid JSON."),
        });
        return;
      }
      if (!isDesktopAppControlResponse(parsed)) {
        finish({ type: "failure", error: new Error("The desktop app response is invalid.") });
        return;
      }
      if (parsed.requestId !== input.request.requestId) {
        finish({
          type: "failure",
          error: new Error("The desktop app response did not match this request."),
        });
        return;
      }
      finish({ type: "success", response: parsed });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        !settled &&
        !connected &&
        input.fallbackAddress !== undefined &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      ) {
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(
          sendDesktopAppActivationRequest({
            address: input.fallbackAddress,
            userId: input.userId,
            request: input.request,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          }),
        );
        return;
      }
      finish({ type: "failure", error });
    });
    socket.once("end", () => {
      finish({ type: "failure", error: new Error("The desktop app closed the connection.") });
    });
  });
}

const appEnvironment = Config.all({
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  sshConnection: Config.String("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.String("SSH_TTY").pipe(Config.option),
});

/** The local desktop app's control socket, plus the dev app's when no T3 home was chosen. */
const resolveControlTarget = Effect.fn("cli.app.resolveControlTarget")(function* (
  baseDirFlag: Option.Option<string>,
) {
  const environment = yield* appEnvironment;
  const hostPlatform = yield* HostProcess.Platform;
  if (Option.isSome(environment.sshConnection) || Option.isSome(environment.sshTty)) {
    return yield* new DesktopAppSshUnsupportedError({});
  }
  if (!isDesktopPlatform(hostPlatform)) {
    return yield* new DesktopAppPlatformUnsupportedError({ platform: hostPlatform });
  }

  const path = yield* Path.Path;
  const configuredBaseDir = Option.getOrUndefined(baseDirFlag) ?? environment.t3Home;
  const baseDir = yield* resolveBaseDir(configuredBaseDir);
  const allowDevFallback = Option.isNone(baseDirFlag) && !environment.t3Home?.trim();
  const userId = yield* HostProcess.UserId;
  const resolveAddress = (stateSubdirectory: "userdata" | "dev") =>
    resolveDesktopAppControlAddress({
      stateDir: path.join(baseDir, stateSubdirectory),
      platform: hostPlatform,
      tempDir: NodeOS.tmpdir(),
      userId,
      joinPath: path.join,
    });
  const crypto = yield* Crypto.Crypto;
  return {
    platform: hostPlatform,
    requestId: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
    userId,
    address: resolveAddress("userdata"),
    fallbackAddress: allowDevFallback ? resolveAddress("dev") : undefined,
  };
});

const sendControlRequest = (
  target: {
    readonly address: DesktopAppControlAddress;
    readonly fallbackAddress: DesktopAppControlAddress | undefined;
    readonly userId: number | undefined;
  },
  request: DesktopAppControlRequest,
  workspaceRoot: string,
) =>
  Effect.tryPromise({
    try: () =>
      sendDesktopAppActivationRequest({
        address: target.address,
        userId: target.userId,
        ...(target.fallbackAddress === undefined
          ? {}
          : { fallbackAddress: target.fallbackAddress }),
        request,
      }),
    catch: (cause) =>
      new DesktopAppUnreachableError({
        candidateAddresses:
          target.fallbackAddress === undefined
            ? [target.address.address]
            : [target.address.address, target.fallbackAddress.address],
        requestId: request.requestId,
        workspaceRoot,
        cause,
      }),
  });

const runAppCommand = Effect.fn("cli.app")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly workspaceRoot: Option.Option<string>;
}) {
  const target = yield* resolveControlTarget(flags.baseDir);
  const path = yield* Path.Path;
  const rawWorkspaceRoot =
    Option.getOrUndefined(flags.workspaceRoot) ?? (yield* HostProcess.WorkingDirectory);
  const workspaceRoot = path.resolve(yield* expandHomePath(rawWorkspaceRoot));
  const request: DesktopAppActivationRequest = {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId: target.requestId,
    type: "open-workspace",
    workspaceRoot,
    platform: target.platform,
  };
  const response = yield* sendControlRequest(target, request, workspaceRoot);
  if (!response.ok) {
    return yield* new DesktopAppRequestFailedError({
      code: isDesktopAppActivationErrorCode(response.code) ? response.code : "internal-error",
      requestId: response.requestId,
      workspaceRoot,
      cause: response,
    });
  }

  yield* Console.log(`Opened ${workspaceRoot} in T3 Code.`);
});

export class DesktopSpeakReplyUsageError extends Schema.TaggedError<DesktopSpeakReplyUsageError>()(
  "DesktopSpeakReplyUsageError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class DesktopSpeakReplyFailedError extends Schema.TaggedError<DesktopSpeakReplyFailedError>()(
  "DesktopSpeakReplyFailedError",
  { code: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `T3 Code could not do that (${this.code}): ${this.detail}`;
  }
}

const runSpeakReplyCommand = Effect.fn("cli.app.speakReply")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly thread: Option.Option<string>;
  readonly text: Option.Option<string>;
  readonly textFile: Option.Option<string>;
  readonly queuedAt: Option.Option<number>;
  readonly send: boolean;
  readonly cancel: boolean;
  readonly status: boolean;
}) {
  const actions = [flags.send, flags.cancel, flags.status, Option.isSome(flags.thread)].filter(
    Boolean,
  ).length;
  if (actions !== 1) {
    return yield* new DesktopSpeakReplyUsageError({
      detail:
        "Use exactly one of: --thread <id> with --text or --text-file (open), --send, --cancel or --status.",
    });
  }
  let text = "";
  if (Option.isSome(flags.thread)) {
    if (Option.isSome(flags.text) === Option.isSome(flags.textFile)) {
      return yield* new DesktopSpeakReplyUsageError({
        detail: "Opening needs exactly one of --text or --text-file.",
      });
    }
    if (Option.isSome(flags.textFile)) {
      const fileSystem = yield* FileSystem.FileSystem;
      const file = flags.textFile.value;
      text = yield* fileSystem.readFileString(file === "-" ? "/dev/stdin" : file).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSpeakReplyUsageError({
              detail: `Could not read ${file}: ${cause.message}`,
            }),
        ),
      );
    } else text = Option.getOrThrow(flags.text);
    text = text.trim();
    if (!text) return yield* new DesktopSpeakReplyUsageError({ detail: "The message is empty." });
    if (text.length > SPEAK_REPLY_MAX_TEXT_LENGTH) {
      return yield* new DesktopSpeakReplyUsageError({
        detail: `The message is longer than ${SPEAK_REPLY_MAX_TEXT_LENGTH} characters.`,
      });
    }
  }

  const target = yield* resolveControlTarget(flags.baseDir);
  const base = {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId: target.requestId,
    type: "speak-reply",
  } as const;
  const request: DesktopSpeakReplyRequest = Option.isSome(flags.thread)
    ? {
        ...base,
        action: "open",
        threadId: ThreadId.make(flags.thread.value.trim()),
        text,
        ...(Option.isSome(flags.queuedAt) ? { queuedAt: flags.queuedAt.value } : {}),
      }
    : { ...base, action: flags.send ? "send" : flags.cancel ? "cancel" : "status" };
  const response = yield* sendControlRequest(target, request, "speak-reply");
  if (!response.ok) {
    return yield* new DesktopSpeakReplyFailedError({
      code: response.code,
      detail: response.message,
    });
  }
  if (!("status" in response)) {
    return yield* new DesktopSpeakReplyFailedError({
      code: "invalid-response",
      detail: "The desktop app answered with something else.",
    });
  }
  if (request.action === "status") {
    yield* Console.log(encodeSpeakReplyStatus(response.status));
    return;
  }
  yield* Console.log(
    request.action === "open"
      ? "Opened the speak-reply window."
      : request.action === "send"
        ? "Sent the reply."
        : "Cancelled the reply; the recording is kept in the thread.",
  );
});

const speakReplyCommand = Command.make("speak-reply", {
  baseDir: baseDirFlag,
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Thread that gets the reply. Opens the window with --text/--text-file."),
    Flag.optional,
  ),
  text: Flag.String("text").pipe(
    Flag.withDescription("The spoken line to show above the recording."),
    Flag.optional,
  ),
  textFile: Flag.String("text-file").pipe(
    Flag.withDescription("Read the spoken line from this file ('-' for stdin)."),
    Flag.optional,
  ),
  queuedAt: Flag.Finite("queued-at").pipe(
    Flag.withDescription(
      "When the line was queued (epoch ms). The details are the latest assistant message at or before it. Default: now.",
    ),
    Flag.optional,
  ),
  send: Flag.Boolean("send").pipe(
    Flag.withDescription("Send the open window's recording."),
    Flag.withDefault(false),
  ),
  cancel: Flag.Boolean("cancel").pipe(
    Flag.withDescription("Close the open window; the recording stays in the thread's composer."),
    Flag.withDefault(false),
  ),
  status: Flag.Boolean("status").pipe(
    Flag.withDescription(
      'Print the window\'s state as JSON: {"open","threadId","phase","recording","heard"}.',
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Show a spoken message in a small always-on-top window that records your spoken reply.",
  ),
  Command.withHandler(runSpeakReplyCommand),
);

export const appCommand = Command.make("app", {
  baseDir: baseDirFlag,
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription("Project directory. Default: current directory."),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription("Open a project in the running T3 Code desktop app."),
  Command.withHandler(runAppCommand),
  Command.withSubcommands([speakReplyCommand]),
);
