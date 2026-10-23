import { DesktopSpeakReplyPageState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWebLinks from "../../app/DesktopWebLinks.ts";
import * as SpeakReplyWindow from "../../window/SpeakReplyWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const close = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEAK_REPLY_CLOSE_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.speakReply.close")(function* (_input, event) {
    if (event === undefined) return;
    const speakReply = yield* SpeakReplyWindow.SpeakReplyWindow;
    yield* speakReply.closeFrom(event.sender.id);
  }),
});

export const reportState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEAK_REPLY_STATE_CHANNEL,
  payload: DesktopSpeakReplyPageState,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.speakReply.reportState")(function* (state, event) {
    if (event === undefined) return;
    const speakReply = yield* SpeakReplyWindow.SpeakReplyWindow;
    yield* speakReply.reportFrom(event.sender.id, state);
  }),
});

const AppOrWebLink = Schema.String.check(
  Schema.isPattern(/^(?:t3code(?:-[a-z]+)?:\/\/threads\/|https?:\/\/)/),
);

export const openInMain = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPEAK_REPLY_OPEN_IN_MAIN_CHANNEL,
  payload: AppOrWebLink,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.speakReply.openInMain")(function* (url, event) {
    if (event === undefined) return;
    const speakReply = yield* SpeakReplyWindow.SpeakReplyWindow;
    if (!(yield* speakReply.isWindow(event.sender.id))) return;
    const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
    yield* webLinks.receive(url);
  }),
});
