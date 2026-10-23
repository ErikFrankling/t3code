import type { ActivityEvent } from "@t3tools/contracts";
import {
  FocusReporter,
  readAloudEvent,
  sendQuietly,
  voiceModeEvent,
} from "@t3tools/client-runtime/activity-log";
import type { ReadAloudPlayed } from "@t3tools/client-runtime/read-aloud";
import type { VoiceLoopSpan } from "@t3tools/client-runtime/voice-loop";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { fetch } from "expo/fetch";

/**
 * Listening and attention reports to the environment's `/api/activity`, over
 * the connection read-aloud already uses (direct only, like read-aloud).
 */
let connection: PreparedConnection | null = null;

export function setActivityConnection(next: PreparedConnection | null) {
  connection = next;
}

const send = async (event: ActivityEvent) => {
  const authorization = connection?.httpAuthorization ?? null;
  if (!connection || authorization?._tag === "Dpop") return;
  await fetch(new URL("/api/activity", connection.httpBaseUrl).toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: `Bearer ${authorization.token}` } : {}),
    },
    body: JSON.stringify(event),
  });
};

export const reportReadAloudPlayed = (played: ReadAloudPlayed) =>
  sendQuietly(send, readAloudEvent(played, "mobile"));

export const reportVoiceModeSpan = (span: VoiceLoopSpan) =>
  sendQuietly(send, voiceModeEvent(span, "mobile"));

export const focusReporter = new FocusReporter({ client: "mobile", send });
