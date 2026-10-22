import type { DictationState } from "@t3tools/contracts";

/**
 * - `recording`: the microphone is feeding it.
 * - `paused`: microphone off, recording open; resumes with the same id and sequence.
 * - `sending`: handed to the chat (or being handed); removed once the server reports `sent`.
 * - `edited`: waiting for the final transcript to go into the composer instead.
 */
export type DictationRecordState = "recording" | "paused" | "sending" | "sent" | "edited";

export interface DictationRecord {
  /** Stable local id; also the first server recording id. */
  readonly id: string;
  /**
   * The speech-service recording that receives the audio. It changes only when
   * the server lost or closed the recording: a continuation then re-uploads all
   * audio under a new id.
   */
  readonly serverId: string;
  readonly target: string;
  readonly environmentId: string;
  readonly project: string;
  readonly threadId: string | null;
  readonly createdAt: number;
  readonly state: DictationRecordState;
  /** Byte length of every stored chunk, in sequence order. */
  readonly sizes: readonly number[];
  /** Chunks the server recording `serverId` holds: the next sequence to upload. */
  readonly uploaded: number;
  /** `start` landed for `serverId`. */
  readonly registered: boolean;
  /** The server queued the delivery; only `sent` remains to be seen. */
  readonly handedOff: boolean;
  readonly server: Pick<DictationState, "status" | "draft" | "final" | "error" | "delivery"> | null;
  /** Why the recording needs the user, in plain words. */
  readonly notice: string;
}

/**
 * Where recordings outlive the page. A chunk and the record that counts it are
 * written in one transaction, so a reload never sees one without the other.
 */
export interface DictationStorage {
  listRecords(): Promise<DictationRecord[]>;
  getRecord(id: string): Promise<DictationRecord | undefined>;
  putRecord(record: DictationRecord): Promise<void>;
  putChunk(record: DictationRecord, sequence: number, samples: Int16Array): Promise<void>;
  getChunk(id: string, sequence: number): Promise<Int16Array | undefined>;
  deleteRecording(id: string): Promise<void>;
}

const copy = (samples: Int16Array) => new Int16Array(samples);

export function memoryDictationStorage(): DictationStorage {
  const records = new Map<string, DictationRecord>();
  const chunks = new Map<string, Int16Array>();
  return {
    listRecords: async () => [...records.values()],
    getRecord: async (id) => records.get(id),
    putRecord: async (record) => {
      records.set(record.id, record);
    },
    putChunk: async (record, sequence, samples) => {
      chunks.set(`${record.id}:${sequence}`, copy(samples));
      records.set(record.id, record);
    },
    getChunk: async (id, sequence) => chunks.get(`${id}:${sequence}`),
    deleteRecording: async (id) => {
      records.delete(id);
      for (const key of chunks.keys()) if (key.startsWith(`${id}:`)) chunks.delete(key);
    },
  };
}

const DATABASE = "t3-dictation";
const RECORDS = "recordings";
const CHUNKS = "chunks";

function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Aborted")));
  });
}

function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

export function indexedDbDictationStorage(factory: IDBFactory = indexedDB): DictationStorage {
  let opening: Promise<IDBDatabase> | null = null;
  const database = () => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore(RECORDS, { keyPath: "id" });
        // Keyed [recording id, sequence], so one recording is one key range.
        request.result.createObjectStore(CHUNKS);
      });
      request.addEventListener("success", () => {
        const opened = request.result;
        opened.addEventListener("close", () => {
          opening = null;
        });
        opened.addEventListener("versionchange", () => {
          opened.close();
          opening = null;
        });
        resolve(opened);
      });
      request.addEventListener("error", () => {
        opening = null;
        reject(request.error);
      });
    });
    return opening;
  };
  const transaction = async (stores: string[], mode: IDBTransactionMode) =>
    (await database()).transaction(stores, mode, { durability: "strict" });
  return {
    listRecords: async () =>
      result((await transaction([RECORDS], "readonly")).objectStore(RECORDS).getAll()),
    getRecord: async (id) =>
      result<DictationRecord | undefined>(
        (await transaction([RECORDS], "readonly")).objectStore(RECORDS).get(id),
      ),
    putRecord: async (record) => {
      const tx = await transaction([RECORDS], "readwrite");
      tx.objectStore(RECORDS).put(record);
      await done(tx);
    },
    putChunk: async (record, sequence, samples) => {
      const tx = await transaction([RECORDS, CHUNKS], "readwrite");
      tx.objectStore(CHUNKS).put(copy(samples).buffer, [record.id, sequence]);
      tx.objectStore(RECORDS).put(record);
      await done(tx);
    },
    getChunk: async (id, sequence) => {
      const buffer = await result<ArrayBuffer | undefined>(
        (await transaction([CHUNKS], "readonly")).objectStore(CHUNKS).get([id, sequence]),
      );
      return buffer ? new Int16Array(buffer) : undefined;
    },
    deleteRecording: async (id) => {
      const tx = await transaction([RECORDS, CHUNKS], "readwrite");
      tx.objectStore(CHUNKS).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      tx.objectStore(RECORDS).delete(id);
      await done(tx);
    },
  };
}
