import type { ActivityEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Appends one client-reported event to `activity_log` (migration 068). A
 * read-aloud play that names only its message gets that message's thread.
 * Returns false for an event with unusable times; a repeat of an event already
 * stored is accepted and ignored.
 */
export const recordActivity = Effect.fn("ActivityLog.record")(function* (event: ActivityEvent) {
  const sql = yield* SqlClient.SqlClient;
  const start = DateTime.make(event.kind === "thread.focus" ? event.at : event.startedAt);
  const end = DateTime.make(event.kind === "thread.focus" ? event.at : event.endedAt);
  if (Option.isNone(start) || Option.isNone(end) || DateTime.isLessThan(end.value, start.value)) {
    return false;
  }

  const messageId = event.kind === "t3.readaloud.played" ? event.messageId : "";
  let threadId = event.threadId ?? "";
  if (!threadId && messageId) {
    const rows = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_messages WHERE message_id = ${messageId}
    `;
    threadId = rows[0]?.thread_id ?? "";
  }
  const seconds =
    event.kind === "t3.readaloud.played"
      ? event.seconds
      : (DateTime.toEpochMillis(end.value) - DateTime.toEpochMillis(start.value)) / 1000;

  // T3's own timestamp format, so the columns sort as text.
  yield* sql`
    INSERT OR IGNORE INTO activity_log
      (kind, thread_id, message_id, client, started_at, ended_at, seconds)
    VALUES
      (${event.kind}, ${threadId}, ${messageId}, ${event.client},
       ${DateTime.formatIso(start.value)}, ${DateTime.formatIso(end.value)}, ${seconds})
  `;
  return true;
});
