import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDictation from "../../app/DesktopDictation.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const report = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_REPORT_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.dictation.report")(function* (recording, event) {
    if (event === undefined) return;
    const dictation = yield* DesktopDictation.DesktopDictation;
    yield* dictation.reportFrom(event.sender.id, recording);
  }),
});
