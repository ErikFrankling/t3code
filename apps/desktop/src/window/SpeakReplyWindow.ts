import type {
  DesktopSpeakReplyCommand,
  DesktopSpeakReplyContent,
  DesktopSpeakReplyPageState,
  DesktopSpeakReplyRequest,
  DesktopSpeakReplyResponse,
  DesktopSpeakReplyStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import { SPEAK_REPLY_COMMAND_CHANNEL, SPEAK_REPLY_CONTENT_CHANNEL } from "../ipc/channels.ts";

/** Window managers match this exact title (Erik's Hyprland rules float, pin and place it). */
export const SPEAK_REPLY_WINDOW_TITLE = "T3 Code — Speak reply";
const WIDTH = 420;
const HEIGHT = 240;
const MARGIN = 16;

const { logWarning } = makeComponentLogger("speak-reply-window");

/** The page route the window loads; the hash router reads it. */
export function speakReplyPageUrl(
  applicationUrl: string,
  content: DesktopSpeakReplyContent,
): string {
  const search = new URLSearchParams({
    threadId: content.threadId,
    request: content.requestId,
    text: content.text,
    ...(content.queuedAt === undefined ? {} : { queuedAt: String(content.queuedAt) }),
  });
  return `${applicationUrl}#/speak-reply?${search.toString()}`;
}

function topRight(): Pick<Electron.Rectangle, "x" | "y"> | Record<string, never> {
  try {
    const area = Electron.screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - WIDTH - MARGIN, y: area.y + MARGIN };
  } catch {
    return {};
  }
}

const CLOSED: DesktopSpeakReplyStatus = {
  open: false,
  threadId: null,
  phase: null,
  recording: false,
  heard: false,
};

export class SpeakReplyWindow extends Context.Service<
  SpeakReplyWindow,
  {
    readonly handle: (
      request: DesktopSpeakReplyRequest,
    ) => Effect.Effect<DesktopSpeakReplyResponse>;
    /** Closes the window when `senderId` is its page; other senders are ignored. */
    readonly closeFrom: (senderId: number) => Effect.Effect<void>;
    readonly reportFrom: (
      senderId: number,
      state: DesktopSpeakReplyPageState,
    ) => Effect.Effect<void>;
    readonly isWindow: (senderId: number) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/window/SpeakReplyWindow") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let current: Electron.BrowserWindow | null = null;
  // Set by the page's first report; a page that has not reported cannot take new content.
  let pageState: DesktopSpeakReplyPageState | null = null;

  const live = () => (current !== null && !current.isDestroyed() ? current : null);

  const status = (): DesktopSpeakReplyStatus => {
    if (live() === null) return CLOSED;
    return {
      open: true,
      threadId: pageState?.threadId ?? null,
      phase: pageState?.phase ?? "starting",
      recording: pageState?.recording ?? false,
      heard: pageState?.heard ?? false,
    };
  };

  const create = Effect.fn("desktop.speakReply.create")(function* () {
    const dark = yield* electronTheme.shouldUseDarkColors;
    const iconPaths = yield* assets.iconPaths;
    const icon =
      environment.platform === "darwin"
        ? {}
        : Option.match(iconPaths[environment.platform === "win32" ? "ico" : "png"], {
            onNone: () => ({}),
            onSome: (path) => ({ icon: path }),
          });
    const window = new Electron.BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      minWidth: 320,
      minHeight: 180,
      ...topRight(),
      title: SPEAK_REPLY_WINDOW_TITLE,
      show: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      autoHideMenuBar: true,
      backgroundColor: dark ? "#0a0a0a" : "#ffffff",
      ...icon,
      webPreferences: {
        preload: environment.preloadPath,
        // It records while Erik works in other windows.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setAlwaysOnTop(true, "floating");
    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(SPEAK_REPLY_WINDOW_TITLE);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(getDesktopUrl(environment.isDevelopment))) event.preventDefault();
    });
    window.webContents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument && current === window) pageState = null;
    });
    // Shown without focus: Erik keeps typing wherever he was.
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) window.showInactive();
    });
    window.on("closed", () => {
      if (current !== window) return;
      current = null;
      pageState = null;
    });
    return window;
  });

  const open = Effect.fn("desktop.speakReply.open")(function* (content: DesktopSpeakReplyContent) {
    const existing = live();
    // One window, reused: a page that is up takes the new content itself, so
    // a recording in progress is never interrupted.
    if (existing !== null && pageState !== null) {
      existing.webContents.send(SPEAK_REPLY_CONTENT_CHANNEL, content);
      if (!existing.isVisible()) existing.showInactive();
      return;
    }
    const window = existing ?? (yield* create());
    current = window;
    pageState = null;
    // Not awaited: the caller never waits on the renderer.
    window
      .loadURL(speakReplyPageUrl(getDesktopUrl(environment.isDevelopment), content))
      .catch((cause: unknown) => {
        runFork(logWarning("speak-reply page failed to load", { cause }));
      });
  });

  const fail = (
    requestId: string,
    code: Extract<DesktopSpeakReplyResponse, { ok: false }>["code"],
    message: string,
  ): DesktopSpeakReplyResponse => ({ version: 1, requestId, ok: false, code, message });
  const ok = (
    requestId: string,
    action: Extract<DesktopSpeakReplyResponse, { ok: true }>["action"],
  ): DesktopSpeakReplyResponse => ({ version: 1, requestId, ok: true, action, status: status() });

  return SpeakReplyWindow.of({
    handle: Effect.fn("SpeakReplyWindow.handle")(
      function* (request) {
        if (request.action === "status") return ok(request.requestId, "status");
        if (request.action === "open") {
          if (!request.text.trim())
            return fail(request.requestId, "invalid-request", "The message text is empty.");
          yield* open({
            requestId: request.requestId,
            threadId: request.threadId,
            text: request.text,
            ...(request.queuedAt === undefined ? {} : { queuedAt: request.queuedAt }),
          });
          return ok(request.requestId, "open");
        }
        const window = live();
        if (window === null)
          return fail(request.requestId, "no-speak-reply-window", "No speak-reply window is open.");
        const command: DesktopSpeakReplyCommand = request.action;
        window.webContents.send(SPEAK_REPLY_COMMAND_CHANNEL, command);
        return ok(request.requestId, request.action);
      },
      (effect, request) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            logWarning("speak-reply request failed", { cause }).pipe(
              Effect.as(
                fail(request.requestId, "window-failed", "The speak-reply window could not open."),
              ),
            ),
          ),
        ),
    ),
    closeFrom: (senderId) =>
      Effect.sync(() => {
        const window = live();
        if (window !== null && window.webContents.id === senderId) window.close();
      }),
    reportFrom: (senderId, state) =>
      Effect.sync(() => {
        const window = live();
        if (window !== null && window.webContents.id === senderId) pageState = state;
      }),
    isWindow: (senderId) => Effect.sync(() => live()?.webContents.id === senderId),
  });
});

export const layer = Layer.effect(SpeakReplyWindow, make);
