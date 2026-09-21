import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CommandId,
  MessageId,
  ThreadId,
  type DictationState,
  ThreadTurnStartCommand,
} from "@t3tools/contracts";
import { DictationDeliveryQueue } from "./DictationDeliveryQueue.ts";

type Turn = typeof ThreadTurnStartCommand.Type;
const command: Turn = {
  type: "thread.turn.start",
  commandId: CommandId.make("recording-1"),
  threadId: ThreadId.make("original-chat"),
  message: {
    messageId: MessageId.make("recording-1"),
    role: "user",
    text: "Existing text\n[dictation:recording-1]",
    attachments: [],
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-09-21T00:00:00.000Z",
};
const input = {
  id: "recording-1",
  owner: "alice",
  command,
  marker: "[dictation:recording-1]",
  draft: "Original live draft",
};
const state = (status: DictationState["status"], final = ""): DictationState => ({
  id: input.id,
  status,
  final,
  draft: "Latest live draft",
  error: "worker failed",
  bytes: 32000,
});
let directory: string;
const queues: DictationDeliveryQueue[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(process.cwd(), ".dictation-test-"));
});
afterEach(async () => {
  await Promise.all(queues.splice(0).map((q) => q.close()));
  await rm(directory, { recursive: true, force: true });
});
function queue(
  speech: (
    owner: string,
    id: string,
    action: "finish" | "retry" | "status",
  ) => Promise<DictationState>,
  dispatch: (command: Turn) => Promise<unknown>,
) {
  const q = new DictationDeliveryQueue({
    directory,
    speech,
    dispatch,
    log: () => {},
    wait: async () => {},
  });
  queues.push(q);
  return q;
}
describe("durable dictation delivery", () => {
  it("delivers the submitted draft when the speech service is unreachable", async () => {
    const sent: Turn[] = [];
    const q = queue(
      async () => {
        throw new Error("connection refused");
      },
      async (c) => {
        sent.push(c);
      },
    );
    await q.start();
    await q.enqueue(input);
    await q.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.text).toBe("Existing text\nOriginal live draft");
    expect(q.get(input.owner, input.id)?.attempts).toBe(3);
  });
  it("recovers a completed third attempt after a process restart", async () => {
    const key = createHash("sha256")
      .update(JSON.stringify([input.owner, input.id]))
      .digest("hex");
    await writeFile(
      join(directory, `${key}.json`),
      JSON.stringify({ ...input, attempts: 3, status: "queued" }),
    );
    const sent: Turn[] = [];
    const q = queue(
      async (_owner, _id, action) => {
        expect(action).toBe("status");
        return state("complete", "Recovered final transcript");
      },
      async (c) => {
        sent.push(c);
      },
    );
    await q.start();
    await q.drain();
    expect(sent[0]?.message.text).toBe("Existing text\nRecovered final transcript");
    expect(q.get(input.owner, input.id)?.usedDraft).toBe(false);
  });
  it("delivers refined text to the captured chat without browser callbacks", async () => {
    const sent: Turn[] = [];
    let attempts = 0;
    const q = queue(
      async () => (++attempts === 1 ? state("error") : state("complete", "Refined $& text")),
      async (c) => {
        sent.push(c);
      },
    );
    await q.start();
    await q.enqueue(input);
    await q.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.threadId).toBe("original-chat");
    expect(sent[0]?.message.text).toBe("Existing text\nRefined $& text");
    expect(attempts).toBe(2);
    expect(q.get("bob", input.id)).toBeUndefined();
  });
  it("sends the latest live draft after three refinement failures", async () => {
    const sent: Turn[] = [];
    let attempts = 0;
    const q = queue(
      async () => {
        attempts++;
        return state("error");
      },
      async (c) => {
        sent.push(c);
      },
    );
    await q.start();
    await q.enqueue(input);
    await q.drain();
    expect(attempts).toBe(3);
    expect(sent[0]?.message.text).toBe("Existing text\nLatest live draft");
    expect(q.get("alice", input.id)?.usedDraft).toBe(true);
  });
  it("deduplicates repeated Stop and resumes the same command after a restart", async () => {
    const sent: Turn[] = [];
    const q = queue(
      async () => state("complete", "Done"),
      async (c) => {
        sent.push(c);
      },
    );
    await q.start();
    await Promise.all([q.enqueue(input), q.enqueue(input)]);
    await q.drain();
    await q.close();
    const restarted = queue(
      async () => {
        throw new Error("Must not transcribe again");
      },
      async (c) => {
        sent.push(c);
      },
    );
    await restarted.start();
    await restarted.enqueue(input);
    await restarted.drain();
    expect(sent).toHaveLength(1);
    await expect(
      restarted.enqueue({
        ...input,
        command: { ...command, threadId: ThreadId.make("wrong-chat") },
      }),
    ).rejects.toThrow("another chat");
  });
  it("retries delivery with the same immutable command ID", async () => {
    const sent: Turn[] = [];
    const q = queue(
      async () => state("complete", "Done"),
      async (c) => {
        sent.push(c);
        if (sent.length === 1) throw new Error("temporary dispatch failure");
      },
    );
    await q.start();
    await q.enqueue(input);
    await q.drain();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.commandId).toBe(sent[1]?.commandId);
    expect(q.get("alice", input.id)?.status).toBe("sent");
  });
});
