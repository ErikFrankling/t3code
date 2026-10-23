import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION = 1 as const;

export const DesktopAppActivationPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type DesktopAppActivationPlatform = typeof DesktopAppActivationPlatform.Type;

export const DesktopAppActivationRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("open-workspace"),
  workspaceRoot: TrimmedNonEmptyString,
  platform: DesktopAppActivationPlatform,
});
export type DesktopAppActivationRequest = typeof DesktopAppActivationRequest.Type;

export const DesktopAppActivationErrorCode = Schema.Literals([
  "invalid-request",
  "renderer-unavailable",
  "environment-unavailable",
  "platform-mismatch",
  "project-create-failed",
  "thread-open-failed",
  "request-timeout",
  "internal-error",
]);
export type DesktopAppActivationErrorCode = typeof DesktopAppActivationErrorCode.Type;

export const DesktopAppActivationSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  projectId: ProjectId,
  threadId: ThreadId,
});
export type DesktopAppActivationSuccess = typeof DesktopAppActivationSuccess.Type;

export const DesktopAppActivationFailure = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(false),
  code: DesktopAppActivationErrorCode,
  message: TrimmedNonEmptyString,
});
export type DesktopAppActivationFailure = typeof DesktopAppActivationFailure.Type;

export const DesktopAppActivationResponse = Schema.Union([
  DesktopAppActivationSuccess,
  DesktopAppActivationFailure,
]);
export type DesktopAppActivationResponse = typeof DesktopAppActivationResponse.Type;

/**
 * Local processes (Erik's speak daemon) ask the running desktop app to open a
 * small always-on-top "Speak reply" window that shows a message and records
 * the answer, then send or cancel it from global hotkeys, and ask whether it
 * is still open before speaking the next message.
 */
export const SPEAK_REPLY_MAX_TEXT_LENGTH = 32_000;

const speakReplyHeader = {
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("speak-reply"),
};

/** What the window shows: the spoken line, and when it was spoken (finds the details message). */
export const DesktopSpeakReplyContent = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  text: Schema.String.check(Schema.isMaxLength(SPEAK_REPLY_MAX_TEXT_LENGTH)),
  /** Epoch ms; the details are the latest assistant message created at or before it. */
  queuedAt: Schema.optional(Schema.Number),
});
export type DesktopSpeakReplyContent = typeof DesktopSpeakReplyContent.Type;

export const DesktopSpeakReplyRequest = Schema.Union([
  Schema.Struct({
    ...speakReplyHeader,
    action: Schema.Literal("open"),
    threadId: ThreadId,
    text: Schema.String.check(Schema.isMaxLength(SPEAK_REPLY_MAX_TEXT_LENGTH)),
    queuedAt: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    ...speakReplyHeader,
    action: Schema.Literals(["send", "cancel", "status"]),
  }),
]);
export type DesktopSpeakReplyRequest = typeof DesktopSpeakReplyRequest.Type;

export const DesktopSpeakReplyPhase = Schema.Literals([
  "starting",
  "recording",
  "silent",
  "sending",
  "error",
]);
export type DesktopSpeakReplyPhase = typeof DesktopSpeakReplyPhase.Type;

/** The window page reports this to the main process on every change. */
export const DesktopSpeakReplyPageState = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  phase: DesktopSpeakReplyPhase,
  /** The microphone is open. */
  recording: Schema.Boolean,
  /** The live preview has heard words in the current recording. */
  heard: Schema.Boolean,
});
export type DesktopSpeakReplyPageState = typeof DesktopSpeakReplyPageState.Type;

export const DesktopSpeakReplyStatus = Schema.Struct({
  open: Schema.Boolean,
  threadId: Schema.NullOr(ThreadId),
  phase: Schema.NullOr(DesktopSpeakReplyPhase),
  recording: Schema.Boolean,
  heard: Schema.Boolean,
});
export type DesktopSpeakReplyStatus = typeof DesktopSpeakReplyStatus.Type;

export const DesktopSpeakReplyErrorCode = Schema.Literals([
  "invalid-request",
  "no-speak-reply-window",
  "window-failed",
]);
export type DesktopSpeakReplyErrorCode = typeof DesktopSpeakReplyErrorCode.Type;

export const DesktopSpeakReplyResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(true),
    action: Schema.Literals(["open", "send", "cancel", "status"]),
    status: DesktopSpeakReplyStatus,
  }),
  Schema.Struct({
    version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(false),
    code: DesktopSpeakReplyErrorCode,
    message: TrimmedNonEmptyString,
  }),
]);
export type DesktopSpeakReplyResponse = typeof DesktopSpeakReplyResponse.Type;

/**
 * Dictation in any desktop window (the chat's card or the speak-reply window).
 * A global hotkey sends the one that is recording without focusing T3 Code
 * (`t3 app dictation --send`); `status` tells whether any window records.
 */
export const DesktopDictationRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("dictation"),
  action: Schema.Literals(["send", "status"]),
});
export type DesktopDictationRequest = typeof DesktopDictationRequest.Type;

export const DesktopDictationStatus = Schema.Struct({
  /** Some window has its microphone open (paused does not count). */
  recording: Schema.Boolean,
});
export type DesktopDictationStatus = typeof DesktopDictationStatus.Type;

export const DesktopDictationErrorCode = Schema.Literals(["no-recording"]);
export type DesktopDictationErrorCode = typeof DesktopDictationErrorCode.Type;

export const DesktopDictationResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(true),
    action: Schema.Literals(["send", "status"]),
    dictation: DesktopDictationStatus,
  }),
  Schema.Struct({
    version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(false),
    code: DesktopDictationErrorCode,
    message: TrimmedNonEmptyString,
  }),
]);
export type DesktopDictationResponse = typeof DesktopDictationResponse.Type;

/** Everything the desktop app control socket accepts. */
export const DesktopAppControlRequest = Schema.Union([
  DesktopAppActivationRequest,
  DesktopSpeakReplyRequest,
  DesktopDictationRequest,
]);
export type DesktopAppControlRequest = typeof DesktopAppControlRequest.Type;

export const DesktopAppControlResponse = Schema.Union([
  DesktopAppActivationResponse,
  DesktopSpeakReplyResponse,
  DesktopDictationResponse,
]);
export type DesktopAppControlResponse = typeof DesktopAppControlResponse.Type;

/** What the speak-reply window's page receives from the desktop main process. */
export type DesktopSpeakReplyCommand = "send" | "cancel";
