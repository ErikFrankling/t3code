import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  AttentionItemId,
  PERSONAL_AGENT_THREAD_ID,
  ProjectId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AttentionItemService from "./AttentionItemService.ts";

const blocked = ThreadId.make("thread:blocked");
const filer = ThreadId.make("thread:filer");

const shell = (threadId: ThreadId, title: string) =>
  ({
    threadId,
    projectId: ProjectId.make("project:personal"),
    title,
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const withService = <A, E>(
  body: (
    service: AttentionItemService.AttentionItemService["Service"],
    sent: Ref.Ref<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
      [],
    );
    const shells = new Map([
      [PERSONAL_AGENT_THREAD_ID, shell(PERSONAL_AGENT_THREAD_ID, "Personal agent")],
      [blocked, shell(blocked, "Blocked work")],
    ]);
    const layer = AttentionItemService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
            sendToThread: (input) =>
              Ref.update(sent, (all) => [...all, input]).pipe(
                Effect.as({ delivery: "queued" } as never),
              ),
          }),
          NodeCrypto.layer,
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* AttentionItemService.AttentionItemService;
      return yield* body(service, sent);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

it.effect("a user tick wakes the personal agent once with what it unblocks", () =>
  withService((service, sent) =>
    Effect.gen(function* () {
      const { item } = yield* service.upsert(
        {
          id: AttentionItemId.make("lastpass-login"),
          title: "Sign in to LastPass in Agent Browser Login",
          unblocks: [blocked],
        },
        { threadId: filer },
      );
      assert.strictEqual(item.sourceThreadId, filer);
      assert.isFalse(item.done);

      yield* service.setDone({ id: item.id, done: true }, { wakePersonalAgent: true });
      // Ticking an already ticked item changes nothing and sends nothing.
      yield* service.setDone({ id: item.id, done: true }, { wakePersonalAgent: true });

      const messages = yield* Ref.get(sent);
      assert.lengthOf(messages, 1);
      const message = messages[0]!;
      assert.strictEqual(message.threadId, PERSONAL_AGENT_THREAD_ID);
      assert.strictEqual(message.mode, "queue");
      assert.include(message.text, "Sign in to LastPass in Agent Browser Login");
      assert.include(message.text, "[Blocked work](t3-thread://v1/thread:blocked)");
    }),
  ),
);

it.effect("an agent resolving an item does not wake the personal agent", () =>
  withService((service, sent) =>
    Effect.gen(function* () {
      const { item } = yield* service.upsert({ title: "Decide: close #180 or talk to Kaan" });
      yield* service.setDone({ id: item.id, done: true }, { wakePersonalAgent: false });
      assert.lengthOf(yield* Ref.get(sent), 0);

      const reopened = yield* service.setDone(
        { id: item.id, done: false },
        { wakePersonalAgent: false },
      );
      assert.isFalse(reopened.item.done);
      assert.isNull(reopened.item.doneAt);
    }),
  ),
);

it.effect("updating an item keeps its done state and unspecified fields", () =>
  withService((service) =>
    Effect.gen(function* () {
      const id = AttentionItemId.make("kth-mail");
      yield* service.upsert({
        id,
        title: "Answer: KTH mail via Executor, skip or do?",
        detail: "https://example.com/kth",
        unblocks: [blocked],
        priority: "high",
      });
      yield* service.setDone({ id, done: true }, { wakePersonalAgent: false });
      const { item } = yield* service.upsert({ id, title: "Answer: KTH mail, skip or do?" });
      assert.strictEqual(item.title, "Answer: KTH mail, skip or do?");
      assert.strictEqual(item.detail, "https://example.com/kth");
      assert.deepStrictEqual(item.unblocks, [blocked]);
      assert.strictEqual(item.priority, "high");
      assert.isTrue(item.done);
    }),
  ),
);

it.effect("lists open items by priority before done ones, and dismiss removes", () =>
  withService((service) =>
    Effect.gen(function* () {
      const low = yield* service.upsert({ title: "Low", priority: "low" });
      const high = yield* service.upsert({ title: "High", priority: "high" });
      const normal = yield* service.upsert({ title: "Normal" });
      yield* service.setDone({ id: high.item.id, done: true }, { wakePersonalAgent: false });
      assert.deepStrictEqual(
        (yield* service.list()).items.map((item) => item.title),
        ["Normal", "Low", "High"],
      );
      yield* service.dismiss({ id: low.item.id });
      assert.deepStrictEqual(
        (yield* service.list()).items.map((item) => item.id),
        [normal.item.id, high.item.id],
      );
    }),
  ),
);
