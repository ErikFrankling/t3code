// @effect-diagnostics nodeBuiltinImport:off -- The hook is a fire-and-forget detached process that must also start while the app quits.
// @effect-diagnostics globalTimers:off -- A hung hook only delays the next one by a bounded time.
import * as NodeChildProcess from "node:child_process";

import type { DesktopDictationRequest, DesktopDictationResponse } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import { DICTATION_SEND_CHANNEL } from "../ipc/channels.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

/**
 * Run with `recording` or `stopped` whenever any window starts or stops
 * recording. Erik's Hyprland binds plain Enter to `t3 app dictation --send`
 * only while it is `recording`.
 */
export const DICTATION_HOOK_ENV = "T3CODE_DICTATION_HOOK";
/** A hook that has not exited by then no longer holds back the next one. */
const HOOK_TIMEOUT_MS = 5_000;

export type DictationHookState = "recording" | "stopped";

export interface DictationRenderer {
  readonly id: number;
  readonly send: () => void;
  readonly isDestroyed: () => boolean;
}

/**
 * Which windows record, in the order they started. The aggregate "some window
 * records" drives the hook; a send goes to the most recent recorder.
 */
export function makeDictationTracker(input: {
  readonly onChange: (state: DictationHookState) => void;
}) {
  // Map order is start order: a window that keeps reporting `true` keeps its place.
  const recorders = new Map<number, DictationRenderer>();
  let recording = false;

  const settle = () => {
    for (const [id, renderer] of recorders) if (renderer.isDestroyed()) recorders.delete(id);
    const now = recorders.size > 0;
    if (now === recording) return;
    recording = now;
    input.onChange(now ? "recording" : "stopped");
  };

  return {
    report: (renderer: DictationRenderer, isRecording: boolean) => {
      if (!isRecording) recorders.delete(renderer.id);
      else if (!recorders.has(renderer.id)) recorders.set(renderer.id, renderer);
      settle();
    },
    /** The window is destroyed, crashed or left the page: it no longer records. */
    gone: (id: number) => {
      recorders.delete(id);
      settle();
    },
    /** Asks the most recent live recorder to send; false when none records. */
    send: (): boolean => {
      settle();
      const latest = [...recorders.values()].at(-1);
      if (latest === undefined) return false;
      latest.send();
      return true;
    },
    recording: () => {
      settle();
      return recording;
    },
    /** The app quits: whatever recorded has stopped. */
    stopAll: () => {
      recorders.clear();
      settle();
    },
  };
}

/**
 * Runs the hook detached, without a shell, one at a time so `recording` and
 * `stopped` never arrive out of order. Only the latest pending state runs.
 */
export function makeDictationHookRunner(input: {
  readonly command: string | undefined;
  readonly spawn: (command: string, state: DictationHookState) => NodeChildProcess.ChildProcess;
  readonly warn: (message: string, cause: unknown) => void;
  readonly timeoutMs?: number;
}) {
  let running = false;
  let pending: DictationHookState | null = null;

  const start = (state: DictationHookState, onDone: () => void) => {
    const command = input.command;
    if (!command) return onDone();
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      onDone();
    };
    const timer = setTimeout(done, input.timeoutMs ?? HOOK_TIMEOUT_MS);
    timer.unref?.();
    try {
      const child = input.spawn(command, state);
      child.once("error", (cause) => {
        input.warn("dictation hook failed", cause);
        done();
      });
      child.once("exit", done);
      child.unref();
    } catch (cause) {
      input.warn("dictation hook failed", cause);
      done();
    }
  };

  const next = () => {
    if (pending === null) {
      running = false;
      return;
    }
    const state = pending;
    pending = null;
    start(state, next);
  };

  return {
    run: (state: DictationHookState) => {
      pending = state;
      if (running) return;
      running = true;
      next();
    },
    /** For quitting: starts it now, even past one still running. */
    runNow: (state: DictationHookState) => {
      pending = null;
      start(state, () => undefined);
    },
  };
}

export function spawnDictationHook(
  command: string,
  state: DictationHookState,
): NodeChildProcess.ChildProcess {
  return NodeChildProcess.spawn(command, [state], {
    detached: true,
    shell: false,
    stdio: "ignore",
  });
}

export class DesktopDictation extends Context.Service<
  DesktopDictation,
  {
    readonly handle: (request: DesktopDictationRequest) => Effect.Effect<DesktopDictationResponse>;
    readonly reportFrom: (senderId: number, recording: boolean) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopDictation") {}

const { logWarning } = makeComponentLogger("desktop-dictation");

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const warn = (message: string, cause: unknown) => void runFork(logWarning(message, { cause }));
  const hook = makeDictationHookRunner({
    command: process.env[DICTATION_HOOK_ENV]?.trim() || undefined,
    spawn: spawnDictationHook,
    warn,
  });
  let quitting = false;
  const tracker = makeDictationTracker({
    onChange: (state) => (quitting ? hook.runNow(state) : hook.run(state)),
  });
  const watched = new Set<number>();

  const watch = (contents: Electron.WebContents) => {
    if (watched.has(contents.id)) return;
    watched.add(contents.id);
    const id = contents.id;
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) tracker.gone(id);
    });
    contents.on("render-process-gone", () => tracker.gone(id));
    contents.once("destroyed", () => {
      watched.delete(id);
      tracker.gone(id);
    });
  };

  const stopAll = () => {
    quitting = true;
    tracker.stopAll();
  };
  Electron.app.once("will-quit", stopAll);
  yield* Effect.addFinalizer(() => Effect.sync(stopAll));

  const reply = (
    request: DesktopDictationRequest,
  ): Extract<DesktopDictationResponse, { ok: true }> => ({
    version: 1,
    requestId: request.requestId,
    ok: true,
    action: request.action,
    dictation: { recording: tracker.recording() },
  });

  return DesktopDictation.of({
    handle: (request) =>
      Effect.sync(() => {
        if (request.action === "status") return reply(request);
        if (!tracker.send()) {
          return {
            version: 1,
            requestId: request.requestId,
            ok: false,
            code: "no-recording",
            message: "No dictation is recording.",
          } as const;
        }
        return reply(request);
      }),
    reportFrom: (senderId, recording) =>
      Effect.sync(() => {
        const contents = Electron.webContents.fromId(senderId);
        if (contents === undefined || contents.isDestroyed()) {
          tracker.gone(senderId);
          return;
        }
        watch(contents);
        tracker.report(
          {
            id: senderId,
            send: () => contents.send(DICTATION_SEND_CHANNEL),
            isDestroyed: () => contents.isDestroyed(),
          },
          recording,
        );
      }),
  });
});

export const layer = Layer.effect(DesktopDictation, make);
