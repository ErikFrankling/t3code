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
  type AttentionItemResult,
  type AttentionItemSetDoneInput,
  type AttentionItemUpsertInput,
  type CommitmentState,
  type CommitmentUpsertInput,
  type TodoStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { parseDocument, type Document } from "yaml";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * The personal agent's to-do list: one markdown file per item in
 * `<baseDir>/personal/todo/`, finished ones in `todo/done/`. The files are the
 * only source of truth. The personal agent edits them directly; this service
 * reads and watches them for the one list in T3 Code, records the user's ticks
 * in them, and lets the older attention and commitment MCP tools write them.
 */

/** Finished items stay visible for a week. */
const DONE_RETENTION_DAYS = 7;
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const STATUSES: ReadonlyArray<TodoStatus> = [
  "actionable",
  "in_flight",
  "blocked",
  "standing",
  "done",
];

export interface CommitmentResolveInput {
  readonly id: AttentionItemId;
  readonly state: CommitmentState;
  readonly proof?: string | null | undefined;
}

export interface AttentionItemSetDoneOptions {
  /**
   * The user ticked the item: record `erik_ticked` and wake the personal agent
   * to verify it. Without it (an agent resolving an item), done moves the file
   * to `done/` and not-done puts it back on the list as needing the user.
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

function itemError(message: string, extra?: { itemId?: AttentionItemId; cause?: unknown }) {
  return new AttentionItemError({
    message,
    ...(extra?.itemId === undefined ? {} : { itemId: extra.itemId }),
    ...(extra?.cause === undefined ? {} : { cause: extra.cause }),
  });
}

/** A file name from a title, such as "Buy 2 YubiKeys" -> "buy-2-yubikeys". */
export function todoSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "item";
}

export interface TodoFile {
  readonly doc: Document;
  readonly body: string;
}

/** Splits a to-do file into its YAML front matter and markdown body. */
export function parseTodoFile(text: string): TodoFile {
  const match = FRONT_MATTER.exec(text);
  if (match === null) return { doc: parseDocument(""), body: text };
  return { doc: parseDocument(match[1] ?? ""), body: match[2] ?? "" };
}

export function renderTodoFile(file: TodoFile): string {
  const front = file.doc.toString().trimEnd();
  const body = file.body.replace(/^\s*\n/, "").trimEnd();
  return `---\n${front}\n---\n${body.length > 0 ? `\n${body}\n` : ""}`;
}

const scalar = (doc: Document, key: string): string | null => {
  const value: unknown = doc.get(key);
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
};

/** The list entry for one file. Unknown values fall back instead of failing. */
export function todoItemFromFile(input: {
  readonly id: string;
  readonly file: TodoFile;
  readonly done: boolean;
  readonly updatedAt: string;
}): AttentionItem {
  const { doc } = input.file;
  const rawStatus = scalar(doc, "status");
  const status = STATUSES.find((candidate) => candidate === rawStatus) ?? "actionable";
  const owner = scalar(doc, "owner");
  const repeatedRaw: unknown = doc.get("repeated");
  const repeated =
    typeof repeatedRaw === "number"
      ? repeatedRaw
      : repeatedRaw === true
        ? 1
        : Number.parseInt(String(repeatedRaw ?? "0"), 10) || 0;
  return {
    id: AttentionItemId.make(input.id),
    title: scalar(doc, "title") ?? input.id,
    status: input.done ? "done" : status,
    blockedOn: scalar(doc, "blocked_on"),
    blockedUntil: scalar(doc, "blocked_until"),
    asked: scalar(doc, "asked"),
    owner: owner === null ? null : ThreadId.make(owner),
    repeated,
    body: input.file.body.trim(),
    erikTicked: scalar(doc, "erik_ticked"),
    done: input.done,
    updatedAt: input.updatedAt,
  };
}

const COMMITMENT_STATUS: Record<CommitmentState, TodoStatus> = {
  open: "actionable",
  in_progress: "in_flight",
  waiting: "blocked",
  done: "done",
};

const threadLink = (threadId: ThreadId, title: string | undefined) =>
  `[${(title ?? threadId).replaceAll("]", ")")}](t3-thread://v1/${threadId})`;

export const layer = Layer.effect(
  AttentionItemService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const threads = yield* ThreadManagementService.ThreadManagementService;

    const todoDir = path.resolve(config.baseDir, "personal", "todo");
    const doneDir = path.join(todoDir, "done");
    yield* fs.makeDirectory(doneDir, { recursive: true }).pipe(Effect.ignoreCause({ log: true }));

    const writeLock = yield* Semaphore.make(1);
    // Every change re-emits the whole (small) list, so subscribers only need
    // the latest signal.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const fail = (message: string, id?: AttentionItemId) => (cause: unknown) =>
      itemError(message, { ...(id === undefined ? {} : { itemId: id }), cause });

    const checkId = (id: string) =>
      SAFE_ID.test(id)
        ? Effect.succeed(AttentionItemId.make(id))
        : Effect.fail(itemError(`${id} is not a valid to-do id (letters, digits, - . _).`));

    const mtimeIso = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) =>
          Option.match(info.mtime, {
            onNone: () => EPOCH_ISO,
            onSome: (mtime) => mtime.toISOString(),
          }),
        ),
        Effect.orElseSucceed(() => EPOCH_ISO),
      );

    const readItem = Effect.fn("AttentionItemService.readItem")(
      function* (dir: string, name: string, done: boolean) {
        const file = path.join(dir, name);
        const text = yield* fs.readFileString(file);
        return todoItemFromFile({
          id: name.slice(0, -".md".length),
          file: parseTodoFile(text),
          done,
          updatedAt: yield* mtimeIso(file),
        });
      },
      // One unreadable file must not hide the rest of the list.
      (effect, _dir, name) =>
        effect.pipe(
          Effect.asSome,
          Effect.catchCause((cause) =>
            Effect.logWarning("Skipping an unreadable to-do file.", { name, cause }).pipe(
              Effect.as(Option.none<AttentionItem>()),
            ),
          ),
        ),
    );

    const readDir = (dir: string, done: boolean) =>
      fs.readDirectory(dir).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
        Effect.map((names) =>
          names.filter(
            (name) =>
              name.endsWith(".md") && name !== "README.md" && SAFE_ID.test(name.slice(0, -3)),
          ),
        ),
        Effect.flatMap((names) =>
          Effect.forEach(names, (name) => readItem(dir, name, done), { concurrency: 8 }),
        ),
        Effect.map((items) => items.flatMap((item) => (Option.isSome(item) ? [item.value] : []))),
      );

    const list: AttentionItemService["Service"]["list"] = Effect.fn("AttentionItemService.list")(
      function* () {
        const cutoff = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, { days: DONE_RETENTION_DAYS }),
        );
        const open = yield* readDir(todoDir, false);
        const done = (yield* readDir(doneDir, true)).filter((item) => item.updatedAt >= cutoff);
        return { items: [...open, ...done].toSorted(compareAttentionItems) };
      },
    );

    // The personal agent writes these files directly, so watch them. Both
    // directories, since a finished item moves between them.
    const watcherScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
    yield* Stream.merge(fs.watch(todoDir), fs.watch(doneDir)).pipe(
      Stream.debounce(Duration.millis(150)),
      Stream.runForEach(() => notifyChanged),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
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

    /** Where the item's file is now, open or done, or null. */
    const locate = Effect.fn("AttentionItemService.locate")(
      function* (id: AttentionItemId) {
        const open = path.join(todoDir, `${id}.md`);
        if (yield* fs.exists(open)) return { file: open, done: false };
        const done = path.join(doneDir, `${id}.md`);
        if (yield* fs.exists(done)) return { file: done, done: true };
        return null;
      },
      (effect, id) => effect.pipe(Effect.mapError(fail("Could not look up the to-do item.", id))),
    );

    const loadItem = Effect.fn("AttentionItemService.loadItem")(function* (id: AttentionItemId) {
      const where = yield* locate(id);
      if (where === null) return yield* itemError(`No to-do item ${id}.`, { itemId: id });
      const text = yield* fs
        .readFileString(where.file)
        .pipe(Effect.mapError(fail("Could not read the to-do item.", id)));
      return { ...where, parsed: parseTodoFile(text) };
    });

    const toItem = Effect.fn("AttentionItemService.toItem")(function* (id: AttentionItemId) {
      const where = yield* locate(id);
      if (where === null) return yield* itemError(`No to-do item ${id}.`, { itemId: id });
      const item = yield* readItem(where.done ? doneDir : todoDir, `${id}.md`, where.done);
      if (Option.isNone(item)) {
        return yield* itemError(`Could not read the to-do item ${id}.`, { itemId: id });
      }
      return item.value;
    });

    /**
     * Writes the item, in `done/` when finished and in `todo/` otherwise,
     * removing the copy in the other folder.
     */
    const save = Effect.fn("AttentionItemService.save")(
      function* (id: AttentionItemId, file: TodoFile, previous: string | null) {
        const finished = scalar(file.doc, "status") === "done";
        const target = path.join(finished ? doneDir : todoDir, `${id}.md`);
        yield* fs.writeFileString(target, renderTodoFile(file));
        if (previous !== null && previous !== target) yield* fs.remove(previous);
        yield* notifyChanged;
        return { item: yield* toItem(id) };
      },
      (effect, id) => effect.pipe(Effect.mapError(fail("Could not save the to-do item.", id))),
    );

    const today = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now).slice(0, 10)));
    const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));

    const newFile = (fields: Record<string, unknown>, body: string): TodoFile => {
      const doc = parseDocument("");
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null) doc.set(key, value);
      }
      return { doc, body };
    };

    const upsert: AttentionItemService["Service"]["upsert"] = (input, caller) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const id = yield* checkId(input.id ?? todoSlug(input.title));
          const owner = input.sourceThreadId ?? caller?.threadId ?? null;
          const unblocks =
            input.unblocks && input.unblocks.length > 0
              ? `Unblocks: ${input.unblocks.map((threadId) => `t3-thread://v1/${threadId}`).join(", ")}`
              : null;
          const where = yield* locate(id);
          if (where === null) {
            const body = [input.detail ? `## Blocked because\n${input.detail}` : null, unblocks]
              .filter((part) => part !== null)
              .join("\n\n");
            const file = newFile(
              {
                title: input.title,
                asked: yield* today,
                status: "blocked",
                blocked_on: "erik",
                owner,
                repeated: 0,
              },
              body,
            );
            return yield* save(id, file, null);
          }
          const current = yield* loadItem(id);
          const { doc } = current.parsed;
          doc.set("title", input.title);
          doc.set("status", "blocked");
          if (scalar(doc, "blocked_on") !== "decision") doc.set("blocked_on", "erik");
          doc.delete("erik_ticked");
          if (owner !== null && scalar(doc, "owner") === null) doc.set("owner", owner);
          let body = current.parsed.body;
          if (input.detail && !body.includes(input.detail)) {
            body = `${body.trimEnd()}\n\n## Update ${yield* today}\n${input.detail}`;
          }
          return yield* save(id, { doc, body }, current.file);
        }),
      );

    const wakePersonalAgent = Effect.fn("AttentionItemService.wakePersonalAgent")(function* (
      item: AttentionItem,
      tickedAt: string,
    ) {
      const agent = yield* threads.getThreadShell(PERSONAL_AGENT_THREAD_ID);
      if (agent === null || agent.deletedAt !== null) {
        yield* Effect.logWarning("To-do item ticked, but there is no personal agent to wake.");
        return;
      }
      const ownerTitle =
        item.owner === null
          ? undefined
          : yield* threads.getThreadShell(item.owner).pipe(
              Effect.map((shell) => shell?.title),
              Effect.orElseSucceed(() => undefined),
            );
      const text = [
        `Erik ticked a to-do item that needed him: **${item.title}** (\`todo/${item.id}.md\`, now with \`erik_ticked: ${tickedAt}\`).`,
        item.owner === null ? null : `Owner: ${threadLink(item.owner, ownerTitle)}.`,
        "Check that it is really done, then change its status (or move it to done/ with proof) and resume the work it blocked. If it is not done, remove erik_ticked and tell him what is missing.",
      ]
        .filter((line) => line !== null)
        .join("\n");
      // Stable per tick, so a retried request does not send the message twice.
      const key = `todo-tick:${item.id}:${tickedAt}`;
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
      const id = yield* checkId(input.id);
      const result = yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadItem(id);
          const { doc } = current.parsed;
          if (options.wakePersonalAgent) {
            // The user's tick only records itself; the agent changes the status.
            if (input.done) {
              if (scalar(doc, "erik_ticked") !== null)
                return { item: yield* toItem(id), ticked: null };
              const tickedAt = yield* nowIso;
              doc.set("erik_ticked", tickedAt);
              const saved = yield* save(id, { doc, body: current.parsed.body }, current.file);
              return { ...saved, ticked: tickedAt };
            }
            doc.delete("erik_ticked");
            return {
              ...(yield* save(id, { doc, body: current.parsed.body }, current.file)),
              ticked: null,
            };
          }
          if (input.done) {
            doc.set("status", "done");
          } else {
            doc.set("status", "blocked");
            doc.set("blocked_on", "erik");
            doc.delete("erik_ticked");
          }
          return {
            ...(yield* save(id, { doc, body: current.parsed.body }, current.file)),
            ticked: null,
          };
        }),
      );
      if (result.ticked !== null) {
        // The tick is saved either way; a failed wake is surfaced, not rolled back.
        yield* wakePersonalAgent(result.item, result.ticked).pipe(
          Effect.mapError(fail("Saved, but the personal agent could not be told.", id)),
        );
      }
      return { item: result.item };
    });

    const dismiss: AttentionItemService["Service"]["dismiss"] = (input) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const id = yield* checkId(input.id);
          const current = yield* loadItem(id);
          const { doc } = current.parsed;
          doc.set("status", "done");
          doc.set("dismissed", yield* today);
          yield* save(id, { doc, body: current.parsed.body }, current.file);
          return { id };
        }),
      );

    const upsertCommitment: AttentionItemService["Service"]["upsertCommitment"] = (input) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          if (input.state === "done") {
            return yield* itemError("Close a commitment with commitment_resolve and its proof.");
          }
          const id = yield* checkId(input.id ?? todoSlug(input.title));
          const status = input.state === undefined ? undefined : COMMITMENT_STATUS[input.state];
          const where = yield* locate(id);
          if (where === null) {
            const body = [
              input.detail ?? null,
              input.proofRequired ? `## Proof needed\n${input.proofRequired}` : null,
            ]
              .filter((part) => part !== null)
              .join("\n\n");
            const file = newFile(
              {
                title: input.title,
                asked: input.askedAt ?? (yield* today),
                status: status ?? "actionable",
                blocked_on: status === "blocked" ? "erik" : undefined,
                owner: input.ownerThreadId ?? undefined,
                repeated: input.repeated ? 1 : 0,
              },
              body,
            );
            return yield* save(id, file, null);
          }
          const current = yield* loadItem(id);
          const { doc } = current.parsed;
          doc.set("title", input.title);
          if (status !== undefined) {
            doc.set("status", status);
            if (status === "blocked" && scalar(doc, "blocked_on") === null)
              doc.set("blocked_on", "erik");
            if (status !== "blocked") doc.delete("blocked_on");
          }
          if (input.ownerThreadId !== undefined) {
            if (input.ownerThreadId === null) doc.delete("owner");
            else doc.set("owner", input.ownerThreadId);
          }
          if (input.askedAt) doc.set("asked", input.askedAt);
          if (input.repeated === true) {
            const repeatedRaw: unknown = doc.get("repeated");
            doc.set("repeated", Math.max(typeof repeatedRaw === "number" ? repeatedRaw : 0, 1));
          }
          let body = current.parsed.body;
          if (input.proofRequired && !body.includes(input.proofRequired)) {
            body = `${body.trimEnd()}\n\n## Proof needed\n${input.proofRequired}`;
          }
          return yield* save(id, { doc, body }, current.file);
        }),
      );

    const resolveCommitment: AttentionItemService["Service"]["resolveCommitment"] = (input) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const id = yield* checkId(input.id);
          const current = yield* loadItem(id);
          const { doc } = current.parsed;
          const proof = input.proof?.trim() || null;
          let body = current.parsed.body;
          if (input.state === "done") {
            if (proof === null && !/^## Proof\s*$/m.test(body)) {
              return yield* itemError(
                "Done needs proof: screenshot paths, a log excerpt or a link you checked yourself.",
                { itemId: id },
              );
            }
          }
          if (proof !== null) body = `${body.trimEnd()}\n\n## Proof\n${proof}`;
          const status = COMMITMENT_STATUS[input.state];
          doc.set("status", status);
          if (status === "blocked" && scalar(doc, "blocked_on") === null)
            doc.set("blocked_on", "erik");
          if (status !== "blocked") doc.delete("blocked_on");
          return yield* save(id, { doc, body }, current.file);
        }),
      );

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
