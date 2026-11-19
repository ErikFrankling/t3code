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

import { environmentFetch } from "../../lib/environmentFetch";

/**
 * Listening and attention reports to the environment's `/api/activity`, over
 * the connection read-aloud already uses.
 */
let connection: PreparedConnection | null = null;

export function setActivityConnection(next: PreparedConnection | null) {
  connection = next;
}

const send = async (event: ActivityEvent) => {
  if (!connection) return;
  await environmentFetch(connection, "/api/activity", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
};

export const reportReadAloudPlayed = (played: ReadAloudPlayed) =>
  sendQuietly(send, readAloudEvent(played, "mobile"));

export const reportVoiceModeSpan = (span: VoiceLoopSpan) =>
  sendQuietly(send, voiceModeEvent(span, "mobile"));

export const focusReporter = new FocusReporter({ client: "mobile", send });
