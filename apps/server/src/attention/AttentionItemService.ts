import {
  AttentionItemError,
  AttentionItemId,
  CommandId,
  compareAttentionItems,
  MessageId,
  PERSONAL_AGENT_THREAD_ID,
  ThreadId,
  type AttentionItem,
  type AttentionItemDismissInput,
  type AttentionItemDismissResult,
  type AttentionItemListResult,
  type AttentionItemPriority,
  type AttentionItemResult,
  type AttentionItemSetDoneInput,
  type AttentionItemUpsertInput,
  type CommitmentState,
  type CommitmentUpsertInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/** Done items stay visible (and can be unticked) for a while, then drop out. */
const DONE_RETENTION_DAYS = 7;

interface AttentionItemRow {
  readonly item_id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly unblocks_json: string;
  readonly source_thread_id: string | null;
  readonly priority: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly done: number;
  readonly done_at: string | null;
  readonly kind: string | null;
  readonly state: string | null;
  readonly owner_thread_id: string | null;
  readonly proof_required: string | null;
  readonly proof: string | null;
  readonly asked_at: string | null;
  readonly repeated: number | null;
}

export interface CommitmentResolveInput {
  readonly id: AttentionItemId;
  readonly state: CommitmentState;
  readonly proof?: string | null | undefined;
}

export interface AttentionItemSetDoneOptions {
  /**
   * The user ticked the item, so the personal agent is told to verify it and
   * resume what it unblocks. An agent resolving its own item does not wake it.
   */
  readonly wakePersonalAgent: boolean;
}

export class AttentionItemService extends Context.Service<
  AttentionItemService,
  {
    readonly list: () => Effect.Effect<AttentionItemListResult, AttentionItemError>;
    readonly subscribeList: () => Stream.Stream<AttentionItemListResult, AttentionItemError>;
    readonly upsert: (
      input: AttentionItemUpsertInput,
      caller?: { readonly threadId: ThreadId | null },
    ) => Effect.Effect<AttentionItemResult, AttentionItemError>;
    readonly setDone: (
      input: AttentionItemSetDoneInput,
      options: AttentionItemSetDoneOptions,
    ) => Effect.Effect<AttentionItemResult, AttentionItemError>;
    readonly dismiss: (
      input: AttentionItemDismissInput,
    ) => Effect.Effect<AttentionItemDismissResult, AttentionItemError>;
    readonly upsertCommitment: (
      input: CommitmentUpsertInput,
    ) => Effect.Effect<AttentionItemResult, AttentionItemError>;
    readonly resolveCommitment: (
      input: CommitmentResolveInput,
    ) => Effect.Effect<AttentionItemResult, AttentionItemError>;
  }
>()("t3/attention/AttentionItemService") {}

const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));

function itemError(message: string, extra?: { itemId?: AttentionItemId; cause?: unknown }) {
  return new AttentionItemError({
    message,
    ...(extra?.itemId === undefined ? {} : { itemId: extra.itemId }),
    ...(extra?.cause === undefined ? {} : { cause: extra.cause }),
  });
}

const UnblocksJson = Schema.fromJsonString(Schema.Array(ThreadId));
const decodeUnblocks = Schema.decodeUnknownOption(UnblocksJson);
const encodeUnblocks = Schema.encodeSync(UnblocksJson);

function parseUnblocks(json: string): ReadonlyArray<ThreadId> {
  return Option.getOrElse(decodeUnblocks(json), () => []);
}

const COMMITMENT_STATES: ReadonlyArray<CommitmentState> = ["open", "in_progress", "waiting", "done"];

function rowToItem(row: AttentionItemRow): AttentionItem {
  const priority: AttentionItemPriority =
    row.priority === "high" || row.priority === "low" ? row.priority : "normal";
  const done = row.done !== 0;
  const state = COMMITMENT_STATES.find((candidate) => candidate === row.state);
  return {
    id: AttentionItemId.make(row.item_id),
    kind: row.kind === "in_flight" ? "in_flight" : "needs_you",
    title: row.title,
    detail: row.detail,
    unblocks: parseUnblocks(row.unblocks_json),
    sourceThreadId: row.source_thread_id === null ? null : ThreadId.make(row.source_thread_id),
    priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    done,
    doneAt: row.done_at,
    state: done ? "done" : (state ?? "open"),
    ownerThreadId: row.owner_thread_id === null ? null : ThreadId.make(row.owner_thread_id),
    proofRequired: row.proof_required,
    proof: row.proof,
    askedAt: row.asked_at,
    repeated: (row.repeated ?? 0) !== 0,
  };
}

const threadLink = (threadId: ThreadId, title: string | undefined) =>
  `[${(title ?? threadId).replaceAll("]", ")")}](t3-thread://v1/${threadId})`;

export const layer = Layer.effect(
  AttentionItemService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threads = yield* ThreadManagementService.ThreadManagementService;

    // A fork-only table, so it must not take a migration id: the migrator
    // skips every id up to the highest recorded one, which would hide the
    // upstream migration that later lands on the same number.
    yield* sql`CREATE TABLE IF NOT EXISTS attention_items (
      item_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      detail TEXT,
      unblocks_json TEXT NOT NULL DEFAULT '[]',
      source_thread_id TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      done_at TEXT
    )`.pipe(Effect.orDie);
    // Columns added after the table first shipped; existing databases get them here.
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(attention_items)`.pipe(
      Effect.orDie,
    );
    const addColumn = (name: string, definition: string) =>
      columns.some((column) => column.name === name)
        ? Effect.void
        : sql.unsafe(`ALTER TABLE attention_items ADD COLUMN ${name} ${definition}`).pipe(Effect.orDie);
    yield* addColumn("kind", "TEXT NOT NULL DEFAULT 'needs_you'");
    yield* addColumn("state", "TEXT");
    yield* addColumn("owner_thread_id", "TEXT");
    yield* addColumn("proof_required", "TEXT");
    yield* addColumn("proof", "TEXT");
    yield* addColumn("asked_at", "TEXT");
    yield* addColumn("repeated", "INTEGER NOT NULL DEFAULT 0");

    // Every change re-emits the whole (small) list, so subscribers only need
    // the latest signal.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const findItem = (id: AttentionItemId) =>
      sql<AttentionItemRow>`SELECT * FROM attention_items WHERE item_id = ${id}`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? null : rowToItem(rows[0]))),
        Effect.mapError((cause) => itemError("Could not read the item.", { itemId: id, cause })),
      );

    const requireItem = (id: AttentionItemId) =>
      findItem(id).pipe(
        Effect.flatMap((item) =>
          item === null
            ? Effect.fail(itemError(`No attention item with id ${id}.`, { itemId: id }))
            : Effect.succeed(item),
        ),
      );

    const list: AttentionItemService["Service"]["list"] = Effect.fn("AttentionItemService.list")(
      function* () {
        const cutoff = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, { days: DONE_RETENTION_DAYS }),
        );
        yield* sql`DELETE FROM attention_items WHERE done = 1 AND done_at < ${cutoff}`;
        const rows = yield* sql<AttentionItemRow>`SELECT * FROM attention_items`;
        return { items: rows.map(rowToItem).toSorted(compareAttentionItems) };
      },
      Effect.mapError((cause) => itemError("Could not list attention items.", { cause })),
    );

    const subscribeList: AttentionItemService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before the snapshot so a change between the two is not lost.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: AttentionItemService["Service"]["upsert"] = Effect.fn(
      "AttentionItemService.upsert",
    )(function* (input, caller) {
      const now = yield* nowIso;
      const id =
        input.id ??
        AttentionItemId.make(
          yield* crypto
            .randomUUIDv4()
            .pipe(Effect.mapError((cause) => itemError("Could not create an id.", { cause }))),
        );
      const existing = yield* findItem(id);
      if (existing !== null && existing.kind === "in_flight") {
        return yield* Effect.fail(
          itemError(`${id} is a commitment; use commitment_upsert.`, { itemId: id }),
        );
      }
      const detail = input.detail !== undefined ? input.detail : (existing?.detail ?? null);
      const unblocks = input.unblocks ?? existing?.unblocks ?? [];
      const sourceThreadId =
        input.sourceThreadId !== undefined
          ? input.sourceThreadId
          : (existing?.sourceThreadId ?? caller?.threadId ?? null);
      const priority = input.priority ?? existing?.priority ?? "normal";
      yield* sql`INSERT INTO attention_items (
          item_id, title, detail, unblocks_json, source_thread_id, priority,
          created_at, updated_at, done, done_at
        ) VALUES (
          ${id}, ${input.title}, ${detail}, ${encodeUnblocks(unblocks)}, ${sourceThreadId},
          ${priority}, ${now}, ${now}, 0, NULL
        )
        ON CONFLICT (item_id) DO UPDATE SET
          title = excluded.title,
          detail = excluded.detail,
          unblocks_json = excluded.unblocks_json,
          source_thread_id = excluded.source_thread_id,
          priority = excluded.priority,
          updated_at = excluded.updated_at`.pipe(
        Effect.mapError((cause) => itemError("Could not save the item.", { itemId: id, cause })),
      );
      yield* notifyChanged;
      return { item: yield* requireItem(id) };
    });

    const wakePersonalAgent = Effect.fn("AttentionItemService.wakePersonalAgent")(function* (
      item: AttentionItem,
    ) {
      const agent = yield* threads.getThreadShell(PERSONAL_AGENT_THREAD_ID);
      if (agent === null || agent.deletedAt !== null) {
        yield* Effect.logWarning("Attention item ticked, but there is no personal agent to wake.");
        return;
      }
      const titleOf = (threadId: ThreadId) =>
        threads.getThreadShell(threadId).pipe(
          Effect.map((shell) => shell?.title),
          Effect.orElseSucceed(() => undefined),
        );
      const unblocks = yield* Effect.forEach(item.unblocks, (threadId) =>
        titleOf(threadId).pipe(Effect.map((title) => threadLink(threadId, title))),
      );
      const source =
        item.sourceThreadId === null
          ? null
          : threadLink(item.sourceThreadId, yield* titleOf(item.sourceThreadId));
      const text = [
        `Erik ticked an item on the Needs you list: **${item.title}** (id \`${item.id}\`).`,
        item.detail ? `Detail: ${item.detail}` : null,
        unblocks.length > 0
          ? `It unblocks: ${unblocks.join(", ")}.`
          : "It lists no blocked threads.",
        source ? `Filed by ${source}.` : null,
        "Check that it is really done, then resume the threads it unblocks. If it is not done, reopen it with attention_item_resolve (action reopen) and say what is missing.",
      ]
        .filter((line) => line !== null)
        .join("\n");
      // Stable per tick, so a retried request does not send the message twice.
      const key = `attention-done:${item.id}:${item.doneAt ?? ""}`;
      yield* threads.sendToThread({
        projectId: agent.projectId,
        commandId: CommandId.make(key),
        threadId: PERSONAL_AGENT_THREAD_ID,
        messageId: MessageId.make(key),
        text,
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      });
    });

    const setDone: AttentionItemService["Service"]["setDone"] = Effect.fn(
      "AttentionItemService.setDone",
    )(function* (input, options) {
      const current = yield* requireItem(input.id);
      if (current.kind === "in_flight") {
        return yield* Effect.fail(
          itemError("Only the personal agent closes in-flight items, and only with proof.", {
            itemId: input.id,
          }),
        );
      }
      if (current.done === input.done) return { item: current };
      const now = yield* nowIso;
      yield* sql`UPDATE attention_items
        SET done = ${input.done ? 1 : 0}, done_at = ${input.done ? now : null}, updated_at = ${now}
        WHERE item_id = ${input.id}`.pipe(
        Effect.mapError((cause) =>
          itemError("Could not update the item.", { itemId: input.id, cause }),
        ),
      );
      yield* notifyChanged;
      const item = yield* requireItem(input.id);
      if (input.done && options.wakePersonalAgent) {
        // The tick is saved either way; a failed wake is surfaced, not rolled back.
        yield* wakePersonalAgent(item).pipe(
          Effect.mapError((cause) =>
            itemError("Saved, but the personal agent could not be told.", {
              itemId: input.id,
              cause,
            }),
          ),
        );
      }
      return { item };
    });

    const dismiss: AttentionItemService["Service"]["dismiss"] = Effect.fn(
      "AttentionItemService.dismiss",
    )(function* (input) {
      yield* sql`DELETE FROM attention_items WHERE item_id = ${input.id}`.pipe(
        Effect.mapError((cause) =>
          itemError("Could not remove the item.", { itemId: input.id, cause }),
        ),
      );
      yield* notifyChanged;
      return { id: input.id };
    });

    const upsertCommitment: AttentionItemService["Service"]["upsertCommitment"] = Effect.fn(
      "AttentionItemService.upsertCommitment",
    )(function* (input) {
      if (input.state === "done") {
        return yield* Effect.fail(
          itemError("Close a commitment with commitment_resolve and its proof."),
        );
      }
      const now = yield* nowIso;
      const id =
        input.id ??
        AttentionItemId.make(
          yield* crypto
            .randomUUIDv4()
            .pipe(Effect.mapError((cause) => itemError("Could not create an id.", { cause }))),
        );
      const existing = yield* findItem(id);
      if (existing !== null && existing.kind !== "in_flight") {
        return yield* Effect.fail(
          itemError(`${id} is a Needs you item, not a commitment.`, { itemId: id }),
        );
      }
      const pick = <K extends keyof CommitmentUpsertInput & keyof AttentionItem>(
        key: K,
        fallback: AttentionItem[K],
      ) => (input[key] !== undefined ? input[key] : (existing?.[key] ?? fallback));
      const detail = pick("detail", null);
      const ownerThreadId = pick("ownerThreadId", null);
      const proofRequired = pick("proofRequired", null);
      const askedAt = pick("askedAt", now.slice(0, 10));
      const repeated = pick("repeated", false);
      // An update that does not name a state keeps it, so a done item stays done.
      const state = input.state ?? existing?.state ?? "open";
      yield* sql`INSERT INTO attention_items (
          item_id, kind, title, detail, unblocks_json, source_thread_id, priority,
          created_at, updated_at, done, done_at, state, owner_thread_id, proof_required,
          proof, asked_at, repeated
        ) VALUES (
          ${id}, 'in_flight', ${input.title}, ${detail}, '[]', NULL, 'normal',
          ${now}, ${now}, 0, NULL, ${state}, ${ownerThreadId}, ${proofRequired},
          NULL, ${askedAt}, ${repeated ? 1 : 0}
        )
        ON CONFLICT (item_id) DO UPDATE SET
          title = excluded.title,
          detail = excluded.detail,
          state = excluded.state,
          owner_thread_id = excluded.owner_thread_id,
          proof_required = excluded.proof_required,
          asked_at = excluded.asked_at,
          repeated = excluded.repeated,
          updated_at = excluded.updated_at`.pipe(
        Effect.mapError((cause) =>
          itemError("Could not save the commitment.", { itemId: id, cause }),
        ),
      );
      yield* notifyChanged;
      return { item: yield* requireItem(id) };
    });

    const resolveCommitment: AttentionItemService["Service"]["resolveCommitment"] = Effect.fn(
      "AttentionItemService.resolveCommitment",
    )(function* (input) {
      const current = yield* requireItem(input.id);
      if (current.kind !== "in_flight") {
        return yield* Effect.fail(
          itemError(`${input.id} is a Needs you item; use attention_item_resolve.`, {
            itemId: input.id,
          }),
        );
      }
      const proof = (input.proof !== undefined ? input.proof : current.proof)?.trim() || null;
      if (input.state === "done" && proof === null) {
        return yield* Effect.fail(
          itemError(
            "Done needs proof: screenshot paths, a log excerpt or a link you checked yourself.",
            { itemId: input.id },
          ),
        );
      }
      const now = yield* nowIso;
      const done = input.state === "done";
      yield* sql`UPDATE attention_items
        SET state = ${input.state}, proof = ${proof}, done = ${done ? 1 : 0},
          done_at = ${done ? (current.doneAt ?? now) : null}, updated_at = ${now}
        WHERE item_id = ${input.id}`.pipe(
        Effect.mapError((cause) =>
          itemError("Could not update the commitment.", { itemId: input.id, cause }),
        ),
      );
      yield* notifyChanged;
      return { item: yield* requireItem(input.id) };
    });

    return {
      list,
      subscribeList,
      upsert,
      setDone,
      dismiss,
      upsertCommitment,
      resolveCommitment,
    } satisfies AttentionItemService["Service"];
  }),
);
