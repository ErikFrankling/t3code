import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AttentionItemId,
  PERSONAL_AGENT_THREAD_ID,
  ProjectId,
  ThreadId,
  todoSection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AttentionItemService from "./AttentionItemService.ts";

const owner = ThreadId.make("thread:owner");
// Any fixed time before the far-future blocked_until in the fixtures.
const NOW = Date.parse("2026-10-23T12:00:00Z");

const shell = (threadId: ThreadId, title: string) =>
  ({
    threadId,
    projectId: ProjectId.make("project:personal"),
    title,
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const todoFile = (fields: string, body = "Body text.") => `---\n${fields}\n---\n\n${body}\n`;

const withService = <A, E>(
  body: (input: {
    readonly service: AttentionItemService.AttentionItemService["Service"];
    readonly sent: Ref.Ref<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>;
    readonly todoDir: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  files: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
      [],
    );
    const shells = new Map([
      [PERSONAL_AGENT_THREAD_ID, shell(PERSONAL_AGENT_THREAD_ID, "Personal agent")],
      [owner, shell(owner, "Owner thread")],
    ]);
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const todoDir = path.join(config.baseDir, "personal", "todo");
    yield* fs.makeDirectory(path.join(todoDir, "done"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(todoDir, name), text);
    }
    const layer = AttentionItemService.layer.pipe(
      Layer.provide(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
          sendToThread: (input) =>
            Ref.update(sent, (all) => [...all, input]).pipe(
              Effect.as({ delivery: "queued" } as never),
            ),
        }),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* AttentionItemService.AttentionItemService;
      return yield* body({ service, sent, todoDir });
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-todo-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

it("parses front matter and keeps unknown keys and the body when rendering", () => {
  const file = AttentionItemService.parseTodoFile(
    todoFile("title: Buy keys\nstatus: blocked\nblocked_on: erik\ncustom: kept", "## Next\nGo."),
  );
  file.doc.set("erik_ticked", "2026-10-23T10:00:00Z");
  const text = AttentionItemService.renderTodoFile(file);
  assert.include(text, "custom: kept");
  assert.include(text, "erik_ticked:");
  assert.include(text, "## Next\nGo.");
  assert.strictEqual(
    AttentionItemService.todoSlug("Buy 2 YubiKeys (5C NFC)!"),
    "buy-2-yubikeys-5c-nfc",
  );
});

it.effect("lists the files in sections, needs-you first, and skips the README", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const { items } = yield* service.list();
        const byId = new Map(items.map((item) => [item.id, item]));
        assert.isFalse(byId.has(AttentionItemId.make("README")));
        assert.strictEqual(
          todoSection(byId.get(AttentionItemId.make("decide"))!, NOW),
          "needs_you",
        );
        assert.strictEqual(todoSection(byId.get(AttentionItemId.make("moving"))!, NOW), "moving");
        assert.strictEqual(todoSection(byId.get(AttentionItemId.make("later"))!, NOW), "waiting");
        assert.strictEqual(todoSection(byId.get(AttentionItemId.make("rule"))!, NOW), "standing");
        const moving = byId.get(AttentionItemId.make("moving"))!;
        assert.strictEqual(moving.owner, owner);
        assert.strictEqual(moving.repeated, 2);
        assert.strictEqual(moving.body, "Body text.");
        assert.strictEqual(items[0]!.id, "moving");
      }),
    {
      "README.md": "# To-do\n",
      "decide.md": todoFile("title: Decide #180\nstatus: blocked\nblocked_on: decision"),
      "moving.md": todoFile(`title: Ship it\nstatus: in_flight\nowner: ${owner}\nrepeated: 2`),
      "later.md": todoFile(
        "title: Check after the nightly\nstatus: blocked\nblocked_on: time\nblocked_until: 2999-01-01T06:00:00+02:00",
      ),
      "rule.md": todoFile("title: Dark mode everywhere\nstatus: standing"),
    },
  ),
);

it.effect("a user tick records erik_ticked and wakes the personal agent once", () =>
  withService(
    ({ service, sent, todoDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const id = AttentionItemId.make("sign-in");
        const { item } = yield* service.setDone({ id, done: true }, { wakePersonalAgent: true });
        assert.isNotNull(item.erikTicked);
        assert.strictEqual(item.status, "blocked");
        yield* service.setDone({ id, done: true }, { wakePersonalAgent: true });
        const messages = yield* Ref.get(sent);
        assert.lengthOf(messages, 1);
        assert.strictEqual(messages[0]!.threadId, PERSONAL_AGENT_THREAD_ID);
        assert.include(messages[0]!.text, "Sign in to LastPass");
        assert.include(messages[0]!.text, "todo/sign-in.md");
        const text = yield* fs.readFileString(`${todoDir}/sign-in.md`);
        assert.include(text, "erik_ticked:");
        assert.include(text, "Keep me.");

        const unticked = yield* service.setDone({ id, done: false }, { wakePersonalAgent: true });
        assert.isNull(unticked.item.erikTicked);
      }),
    {
      "sign-in.md": todoFile(
        "title: Sign in to LastPass\nstatus: blocked\nblocked_on: erik",
        "Keep me.",
      ),
    },
  ),
);

it.effect("the old tools write the same files: upsert, commitment, done with proof", () =>
  withService(({ service, todoDir }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const created = yield* service.upsert(
        { title: "Buy 2 YubiKeys", detail: "Order at Inet." },
        { threadId: owner },
      );
      assert.strictEqual(created.item.id, "buy-2-yubikeys");
      assert.strictEqual(todoSection(created.item, NOW), "needs_you");
      assert.strictEqual(created.item.owner, owner);

      const commitment = yield* service.upsertCommitment({
        id: AttentionItemId.make("ship-list"),
        title: "Ship the one list",
        state: "in_progress",
        ownerThreadId: owner,
        proofRequired: "Screenshots",
        repeated: true,
      });
      assert.strictEqual(commitment.item.status, "in_flight");
      assert.strictEqual(commitment.item.repeated, 1);

      const bare = yield* Effect.flip(
        service.resolveCommitment({ id: AttentionItemId.make("ship-list"), state: "done" }),
      );
      assert.include(bare.message, "proof");
      const closed = yield* service.resolveCommitment({
        id: AttentionItemId.make("ship-list"),
        state: "done",
        proof: "/tmp/shot.png",
      });
      assert.isTrue(closed.item.done);
      assert.isFalse(yield* fs.exists(`${todoDir}/ship-list.md`));
      assert.include(
        yield* fs.readFileString(`${todoDir}/done/ship-list.md`),
        "## Proof\n/tmp/shot.png",
      );

      const unsafe = yield* Effect.flip(
        service.setDone(
          { id: AttentionItemId.make("../x"), done: true },
          { wakePersonalAgent: true },
        ),
      );
      assert.include(unsafe.message, "not a valid");
    }),
  ),
);
