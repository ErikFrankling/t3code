import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { recordActivity } from "./activityLog.ts";
import { runMigrations } from "./persistence/Migrations.ts";

type Row = {
  readonly kind: string;
  readonly thread_id: string;
  readonly message_id: string;
  readonly client: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly seconds: number;
};

it.effect("stores read-aloud plays, voice spans and focus once each", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('m1', 'thread-a', 'assistant', 0, '2026-10-23T09:00:00.000Z', '2026-10-23T09:00:00.000Z', '{}')
    `;

    const play = {
      kind: "t3.readaloud.played" as const,
      messageId: "m1",
      client: "web",
      startedAt: "2026-10-23T10:00:00Z",
      endedAt: "2026-10-23T10:01:30Z",
      seconds: 72.5,
    };
    assert.isTrue(yield* recordActivity(play));
    assert.isTrue(yield* recordActivity(play), "a retry is accepted");
    assert.isTrue(
      yield* recordActivity({
        kind: "t3.voicemode.span",
        threadId: "thread-a",
        client: "mobile",
        startedAt: "2026-10-23T11:00:00.000Z",
        endedAt: "2026-10-23T11:10:00.000Z",
      }),
    );
    assert.isTrue(
      yield* recordActivity({
        kind: "thread.focus",
        threadId: "thread-b",
        client: "desktop",
        at: "2026-10-23T12:00:00.000Z",
      }),
    );
    assert.isFalse(
      yield* recordActivity({
        kind: "t3.voicemode.span",
        client: "web",
        startedAt: "2026-10-23T11:10:00.000Z",
        endedAt: "2026-10-23T11:00:00.000Z",
      }),
      "an end before the start is refused",
    );

    const rows = yield* sql<Row>`SELECT * FROM activity_log ORDER BY started_at`;
    assert.deepStrictEqual(
      rows.map((r) => [r.kind, r.thread_id, r.message_id, r.client, r.started_at, r.seconds]),
      [
        ["t3.readaloud.played", "thread-a", "m1", "web", "2026-10-23T10:00:00.000Z", 72.5],
        ["t3.voicemode.span", "thread-a", "", "mobile", "2026-10-23T11:00:00.000Z", 600],
        ["thread.focus", "thread-b", "", "desktop", "2026-10-23T12:00:00.000Z", 0],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
