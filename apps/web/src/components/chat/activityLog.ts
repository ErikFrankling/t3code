import type { ActivityEvent, EnvironmentId } from "@t3tools/contracts";
import {
  FocusReporter,
  readAloudEvent,
  sendQuietly,
  voiceModeEvent,
  type ActivityClient,
} from "@t3tools/client-runtime/activity-log";
import type { ReadAloudPlayed } from "@t3tools/client-runtime/read-aloud";
import type { VoiceLoopSpan } from "@t3tools/client-runtime/voice-loop";

import { isElectron } from "../../env";
import { environmentFetch } from "./environmentFetch";

const client: ActivityClient = isElectron ? "desktop" : "web";

let environment: EnvironmentId | null = null;

/** Where reports go, when no thread is in focus to say so. */
export function setActivityEnvironment(environmentId: EnvironmentId) {
  environment = environmentId;
}

const send = async (event: ActivityEvent) => {
  if (!environment) return;
  await environmentFetch(environment, "/api/activity", event, 10_000);
};

export const reportReadAloudPlayed = (played: ReadAloudPlayed) =>
  sendQuietly(send, readAloudEvent(played, client));

export const reportVoiceModeSpan = (span: VoiceLoopSpan) =>
  sendQuietly(send, voiceModeEvent(span, client));

const focusReporter = new FocusReporter({ client, send });
let focusedThread: string | null = null;

// Attention needs the window in front: a hidden tab or another app is not focus.
const syncFocus = () =>
  focusReporter.focus(
    typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
      ? focusedThread
      : null,
  );

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", syncFocus);
  window.addEventListener("focus", syncFocus);
  window.addEventListener("blur", syncFocus);
}

/** The thread the user is looking at, or null when none is open. */
export function setFocusedThread(environmentId: EnvironmentId, threadId: string | null) {
  environment = environmentId;
  focusedThread = threadId;
  syncFocus();
}
