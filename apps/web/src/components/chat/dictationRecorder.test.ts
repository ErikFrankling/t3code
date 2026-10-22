import { describe, expect, it } from "vite-plus/test";
import type { DictationRequest, DictationState } from "@t3tools/contracts";

import { DictationHttpError, DictationRecorder, type DictationHandoff } from "./dictationRecorder";
import { memoryDictationStorage, type DictationStorage } from "./dictationStorage";

/** The speech gateway's append/start/finish/status/cancel semantics (tools/local-stt/gateway.py). */
function fakeGateway() {
  const recordings = new Map<
    string,
    { status: DictationState["status"]; chunks: number[]; bytes: number; final: string }
  >();
  const deliveries = new Map<string, NonNullable<DictationState["delivery"]>>();
  const gateway = {
    down: false,
    recordings,
    deliveries,
    /** First sample of every chunk the server holds, in order. */
    heard: (id: string) => recordings.get(id)?.chunks ?? [],
    request: async (_environmentId: string, body: DictationRequest): Promise<DictationState> => {
      await Promise.resolve();
      if (gateway.down) throw new DictationHttpError(502, "Speech service unavailable");
      const id = body.id ?? "";
      if (body.action === "start" && !recordings.has(id))
        recordings.set(id, { status: "recording", chunks: [], bytes: 0, final: "" });
      const recording = recordings.get(id);
      if (!recording) throw new DictationHttpError(404, "Not found");
      if (body.action === "append") {
        if (recording.status !== "recording")
          throw new DictationHttpError(409, "Recording is already closed.");
        const sequence = body.sequence ?? -1;
        if (sequence !== recording.chunks.length - 1) {
          if (sequence !== recording.chunks.length)
            throw new DictationHttpError(409, "Unexpected audio chunk sequence.");
          const bytes = Uint8Array.from(atob(body.audio ?? ""), (char) => char.charCodeAt(0));
          recording.chunks.push(new Int16Array(bytes.buffer)[0] ?? 0);
          recording.bytes += bytes.byteLength;
        }
      }
      if (body.action === "finish") {
        recording.status = "complete";
        recording.final = `final of ${recording.chunks.length} chunks`;
      }
      if (body.action === "cancel") recording.status = "cancelled";
      const delivery = deliveries.get(id);
      return {
        id,
        status: recording.status,
        draft: `draft of ${recording.chunks.length} chunks`,
        final: recording.final,
        error: "",
        bytes: recording.bytes,
        ...(delivery ? { delivery } : {}),
      };
    },
  };
  return gateway;
}

let next = 0;

/** A page: its own recorder over the device's storage. Closing it stops its loops. */
function page(storage: DictationStorage, gateway: ReturnType<typeof fakeGateway>) {
  let closed = false;
  const recorder = new DictationRecorder({
    storage,
    request: (environmentId, body) => {
      if (closed) return new Promise(() => undefined);
      return gateway.request(environmentId, body);
    },
    newId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    wait: () =>
      closed ? new Promise(() => undefined) : new Promise((resolve) => setTimeout(resolve, 0)),
    lock: (_name, hold) => void hold(),
  });
  return {
    recorder,
    close: () => {
      closed = true;
    },
    entry: (id: string) => recorder.getSnapshot().find((entry) => entry.record.id === id),
  };
}

/** Lets the upload loops run until `condition` holds (they only ever yield to timers). */
async function until(condition: () => boolean) {
  for (let turn = 0; turn < 2000; turn++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition never held");
}

const chunk = (value: number) => new Int16Array(16000).fill(value);
const recording = { target: "chat-1", environmentId: "env", project: "/repo", threadId: "t-1" };

describe("durable dictation", () => {
  it("keeps every chunk on the device while the server is down and uploads them in order later", async () => {
    const storage = memoryDictationStorage();
    const gateway = fakeGateway();
    gateway.down = true;
    const { recorder, entry, close } = page(storage, gateway);
    const id = await recorder.create(recording);
    for (let n = 1; n <= 5; n++) await recorder.append(id, chunk(n));
    await until(() => entry(id)?.upload === "waiting");
    expect(entry(id)?.error).toBe("The speech service is not reachable right now.");
    expect(gateway.recordings.size).toBe(0);
    for (let n = 0; n < 5; n++) expect((await storage.getChunk(id, n))?.[0]).toBe(n + 1);

    gateway.down = false;
    await until(() => entry(id)?.upload === "uploaded");
    expect(gateway.heard(id)).toEqual([1, 2, 3, 4, 5]);
    expect(entry(id)?.record.state).toBe("recording");
    expect(entry(id)?.error).toBe("");
    close();
  });

  it("resumes a recording interrupted by a reload as paused, with all of its audio", async () => {
    const storage = memoryDictationStorage();
    const gateway = fakeGateway();
    const first = page(storage, gateway);
    const id = await first.recorder.create(recording);
    await first.recorder.append(id, chunk(1));
    await until(() => first.entry(id)?.upload === "uploaded");
    gateway.down = true;
    await first.recorder.append(id, chunk(2));
    await first.recorder.append(id, chunk(3));
    first.close();

    const second = page(storage, gateway);
    await second.recorder.load();
    await until(() => second.entry(id) !== undefined);
    expect(second.entry(id)?.record.state).toBe("paused");
    expect(second.entry(id)?.record.sizes).toHaveLength(3);
    gateway.down = false;
    await until(() => second.entry(id)?.upload === "uploaded");

    second.recorder.resume(id);
    await second.recorder.append(id, chunk(4));
    await until(() => second.entry(id)?.record.uploaded === 4);
    // Same server recording, same sequence: nothing duplicated or lost.
    expect(second.entry(id)?.record.serverId).toBe(id);
    expect(gateway.heard(id)).toEqual([1, 2, 3, 4]);
    second.close();
  });

  it("removes the device copy only after the server reports the message sent", async () => {
    const storage = memoryDictationStorage();
    const gateway = fakeGateway();
    gateway.down = true;
    const { recorder, entry, close } = page(storage, gateway);
    const id = await recorder.create(recording);
    await recorder.append(id, chunk(1));
    await recorder.append(id, chunk(2));
    recorder.pause(id);

    let uploadedBeforeHandoff = -1;
    const handoff: DictationHandoff = async (serverId, _draft, uploaded) => {
      await uploaded;
      uploadedBeforeHandoff = gateway.heard(serverId).length;
      gateway.deliveries.set(serverId, "queued");
    };
    const sending = recorder.send(id, handoff);
    await until(() => entry(id)?.upload === "waiting");
    gateway.down = false;
    await sending;
    expect(uploadedBeforeHandoff).toBe(2);
    expect(entry(id)?.record).toMatchObject({ state: "sending", handedOff: true });

    await until(() => entry(id)?.record.server?.delivery === "queued");
    expect(await storage.getRecord(id)).toBeDefined();
    expect(await storage.getChunk(id, 1)).toBeDefined();

    gateway.deliveries.set(id, "sent");
    await until(() => entry(id) === undefined);
    expect(await storage.getRecord(id)).toBeUndefined();
    expect(await storage.getChunk(id, 0)).toBeUndefined();
    close();
  });

  it("keeps the recording when the chat refuses it", async () => {
    const storage = memoryDictationStorage();
    const gateway = fakeGateway();
    const { recorder, entry, close } = page(storage, gateway);
    const id = await recorder.create(recording);
    await recorder.append(id, chunk(1));
    await recorder.send(id, async () => {
      throw new Error("This chat could not accept the message.");
    });
    expect(entry(id)?.record.state).toBe("paused");
    expect(entry(id)?.record.notice).toContain("This chat could not accept the message.");
    expect((await storage.getRecord(id))?.state).toBe("paused");
    close();
  });

  it("treats a send interrupted by a reload as unsent unless the server has the delivery", async () => {
    const storage = memoryDictationStorage();
    const gateway = fakeGateway();
    const first = page(storage, gateway);
    const id = await first.recorder.create(recording);
    await first.recorder.append(id, chunk(1));
    void first.recorder.send(id, () => new Promise(() => undefined));
    await until(() => first.entry(id)?.upload === "uploaded");
    first.close();

    const second = page(storage, gateway);
    await second.recorder.load();
    await until(() => second.entry(id)?.record.state === "paused");
    expect(second.entry(id)?.record.notice).toContain("page closed");
    second.close();
  });

  it("puts the final transcript into the composer on Edit, then forgets the recording", async () => {
    const storage = memoryDictationStorage();
    const gateway = fakeGateway();
    const { recorder, entry, close } = page(storage, gateway);
    const id = await recorder.create(recording);
    await recorder.append(id, chunk(1));
    await recorder.append(id, chunk(2));
    await recorder.edit(id);
    await until(() => entry(id)?.record.server?.status === "complete");
    // No composer for the chat is open yet: the recording waits for one.
    expect(await storage.getRecord(id)).toBeDefined();

    const inserted: string[] = [];
    recorder.registerEditor("chat-1", (text) => inserted.push(text) > 0);
    await until(() => entry(id) === undefined);
    expect(inserted).toEqual(["final of 2 chunks"]);
    expect(await storage.getRecord(id)).toBeUndefined();
    close();
  });

  it("continues in a new server recording when the server lost the old one", async () => {
    const storage = memoryDictationStorage();
    const gateway = fakeGateway();
    const { recorder, entry, close } = page(storage, gateway);
    const id = await recorder.create(recording);
    await recorder.append(id, chunk(1));
    await until(() => entry(id)?.upload === "uploaded");
    gateway.recordings.delete(id);
    await recorder.append(id, chunk(2));
    await until(() => entry(id)?.upload === "uploaded" && entry(id)?.record.serverId !== id);
    expect(gateway.heard(entry(id)!.record.serverId)).toEqual([1, 2]);
    close();
  });

  it("never cancels on the server except for a confirmed delete", async () => {
    const storage = memoryDictationStorage();
    const gateway = fakeGateway();
    const actions: string[] = [];
    const request = gateway.request;
    gateway.request = (environmentId, body) => {
      actions.push(body.action);
      return request(environmentId, body);
    };
    const first = page(storage, gateway);
    const id = await first.recorder.create(recording);
    await first.recorder.append(id, chunk(1));
    first.recorder.pause(id);
    await until(() => first.entry(id)?.upload === "uploaded");
    first.close();
    const second = page(storage, gateway);
    await second.recorder.load();
    await until(() => second.entry(id) !== undefined);
    expect(actions).not.toContain("cancel");

    await second.recorder.remove(id);
    expect(await storage.getRecord(id)).toBeUndefined();
    await until(() => actions.includes("cancel"));
    // The speech service keeps the audio of a cancelled recording.
    expect(gateway.heard(id)).toEqual([1]);
    second.close();
  });
});
