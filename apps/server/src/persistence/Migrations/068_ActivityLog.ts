import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Append-only: read-aloud plays, voice-mode spans and thread focus, for
  // Erik's Time tracker. Nothing in T3 reads it back. The unique key makes a
  // client's retry a no-op.
  yield* sql`
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      client TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      seconds REAL NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_activity_log_event
    ON activity_log(kind, client, started_at, thread_id, message_id)
  `;
  yield* sql`CREATE INDEX idx_activity_log_started ON activity_log(started_at)`;
});
