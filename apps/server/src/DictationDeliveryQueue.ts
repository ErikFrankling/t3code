// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The on-disk queue is plain synchronous Node I/O so a recording survives a server restart.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import type { DictationState, DictationTurn } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The chat a turn goes to; the client always names it, even for a new chat. */
export const dictationTurnThreadId = (turn: DictationTurn): string | undefined =>
  turn.method === "launchThread"
    ? turn.input.threadId
    : "threadId" in turn.command
      ? turn.command.threadId
      : undefined;

const withMessageText = (turn: DictationTurn, text: (current: string) => string): DictationTurn => {
  if (turn.method === "launchThread") {
    const message = turn.input.initialMessage;
    return message
      ? {
          ...turn,
          input: { ...turn.input, initialMessage: { ...message, text: text(message.text) } },
        }
      : turn;
  }
  return turn.command.type === "message.dispatch"
    ? { ...turn, command: { ...turn.command, text: text(turn.command.text) } }
    : turn;
};

/**
 * What a transcript is when the recogniser only annotated the sound
 * ("[Unintelligible Speech]", "[Human Sounds]"): no words, so the live draft
 * is the better message.
 */
export const hasSpokenWords = (text: string): boolean =>
  text.replace(/\[[^\]]*\]/g, "").trim().length > 0;

export interface DeliveryJob {
  id: string;
  owner: string;
  turn: DictationTurn;
  queuedAt: string;
  marker: string;
  draft: string;
  attempts: number;
  status: "queued" | "ready" | "sent" | "empty" | "abandoned";
  usedDraft?: boolean;
  error?: string;
  retryAt?: number;
  transcript?: string;
}
interface Dependencies {
  directory: string;
  speech: (
    owner: string,
    id: string,
    action: "finish" | "retry" | "status",
  ) => Promise<DictationState>;
  dispatch: (turn: DictationTurn) => Promise<unknown>;
  log: (event: string, fields: Record<string, unknown>) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** The speech service no longer has this recording; waiting cannot produce a transcript. */
export class DictationRecordingUnavailable extends Schema.TaggedError<DictationRecordingUnavailable>()(
  "DictationRecordingUnavailable",
  { message: Schema.String },
) {}

const isDictationRecordingUnavailable = Schema.is(DictationRecordingUnavailable);

/** Persist the destination and immutable turn before acknowledging Stop. */
export class DictationDeliveryQueue {
  private readonly jobs = new Map<string, DeliveryJob>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  private mutation = Promise.resolve();
  private writes = Promise.resolve();
  private readonly active = new Map<string, "speech" | "dispatch">();
  private readonly deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  private key(owner: string, id: string) {
    return NodeCrypto.createHash("sha256")
      .update(JSON.stringify([owner, id]))
      .digest("hex");
  }
  private save(job: DeliveryJob) {
    const snapshot = { ...job };
    const operation = this.writes.then(() => this.write(snapshot));
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  private async write(job: DeliveryJob) {
    const file = NodePath.join(this.deps.directory, `${this.key(job.owner, job.id)}.json`);
    const checkpoint = await NodeFSP.open(`${file}.new`, "w", 0o600);
    try {
      await checkpoint.writeFile(JSON.stringify(job));
      await checkpoint.sync();
    } finally {
      await checkpoint.close();
    }
    await NodeFSP.rename(`${file}.new`, file);
    const directory = await NodeFSP.open(this.deps.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async start() {
    await NodeFSP.mkdir(this.deps.directory, { recursive: true, mode: 0o700 });
    for (const name of await NodeFSP.readdir(this.deps.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const job: DeliveryJob = JSON.parse(
          await NodeFSP.readFile(NodePath.join(this.deps.directory, name), "utf8"),
        );
        if (
          typeof job.owner !== "string" ||
          typeof job.id !== "string" ||
          !job.turn ||
          !dictationTurnThreadId(job.turn) ||
          !Number.isInteger(job.attempts) ||
          !["queued", "ready", "sent", "empty", "abandoned"].includes(job.status)
        ) {
          throw new Error("Invalid delivery checkpoint");
        }
        this.jobs.set(this.key(job.owner, job.id), job);
        // Resume recoverable work; cancelled and permanently failed deliveries
        // stay stopped, with their transcript available for explicit recovery.
        this.launch(job);
      } catch (error) {
        // Move what cannot be read aside once, so it neither blocks nor logs on
        // every start. Nothing is deleted: the file stays in `unreadable/`.
        let quarantined = false;
        try {
          const aside = NodePath.join(this.deps.directory, "unreadable");
          await NodeFSP.mkdir(aside, { recursive: true, mode: 0o700 });
          await NodeFSP.rename(
            NodePath.join(this.deps.directory, name),
            NodePath.join(aside, name),
          );
          quarantined = true;
        } catch {
          // Left in place; the next start reports it again.
        }
        this.deps.log("dictation.checkpoint_failed", {
          file: name,
          error: String(error),
          quarantined,
        });
      }
    }
  }
  get(owner: string, id: string) {
    return this.jobs.get(this.key(owner, id));
  }
  isActive(owner: string, id: string) {
    return this.active.has(this.key(owner, id));
  }
  async stop(owner: string, id: string) {
    const job = this.get(owner, id);
    if (!job) return true;
    // Intake may already have accepted this message. Never report cancellation
    // while that result is unknown.
    if (this.active.get(this.key(owner, id)) === "dispatch") return false;
    if (job.status === "sent") return true;
    job.status = "abandoned";
    delete job.error;
    delete job.retryAt;
    await this.save(job);
    return true;
  }
  private stopped(job: DeliveryJob) {
    return job.status === "abandoned" || this.controller.signal.aborted;
  }
  private async speech(job: DeliveryJob, action: "finish" | "retry" | "status") {
    const key = this.key(job.owner, job.id);
    this.active.set(key, "speech");
    delete job.retryAt;
    delete job.error;
    try {
      return await this.deps.speech(job.owner, job.id, action);
    } finally {
      this.active.delete(key);
    }
  }
  async enqueue(input: Omit<DeliveryJob, "attempts" | "status" | "queuedAt">) {
    const operation = this.mutation.then(async () => {
      const existing = this.get(input.owner, input.id);
      if (existing) {
        if (dictationTurnThreadId(existing.turn) !== dictationTurnThreadId(input.turn))
          throw new Error("Recording already belongs to another chat.");
        return existing;
      }
      const job: DeliveryJob = {
        ...input,
        queuedAt: new Date().toISOString(),
        attempts: 0,
        status: "queued",
      };
      await this.save(job);
      this.jobs.set(this.key(job.owner, job.id), job);
      this.deps.log("dictation.queued", {
        recordingId: job.id,
        threadId: dictationTurnThreadId(job.turn),
      });
      this.launch(job);
      return job;
    });
    this.mutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  private launch(job: DeliveryJob) {
    const key = this.key(job.owner, job.id);
    if (job.status !== "queued" && job.status !== "ready") return;
    if (this.tasks.has(key)) return;
    const task = this.run(job)
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted)
          this.deps.log("dictation.worker_failed", { recordingId: job.id, error: String(error) });
      })
      .finally(() => {
        this.tasks.delete(key);
      });
    this.tasks.set(key, task);
  }
  private wait(ms: number) {
    return this.deps.wait
      ? this.deps.wait(ms, this.controller.signal)
      : NodeTimersPromises.setTimeout(ms, undefined, { signal: this.controller.signal });
  }
  private async settledState(job: DeliveryJob, initial: DictationState) {
    let state = initial;
    while (!this.stopped(job)) {
      if (state.draft.trim()) job.draft = state.draft;
      if (state.status !== "recording" && state.status !== "finalizing") return state;
      await this.wait(800);
      if (this.stopped(job)) break;
      state = await this.speech(job, "status");
    }
    return state;
  }
  private async run(job: DeliveryJob) {
    let text = "";
    // The message waits for the full-quality transcript for as long as that
    // takes: the speech service retries through GPU contention and restarts on
    // its own, and an unreachable service is simply asked again. "finish" is
    // idempotent, so resuming after a restart costs no extra transcription.
    // Only a definite answer ends the wait: a transcript, no speech, or a
    // recording that no longer exists (the live draft is all there is).
    let failures = 0;
    while (job.status === "queued" && !this.controller.signal.aborted) {
      job.attempts++;
      await this.save(job);
      if (this.stopped(job)) return;
      this.deps.log("dictation.refinement_attempt", { recordingId: job.id, attempt: job.attempts });
      try {
        const state = await this.settledState(
          job,
          await this.speech(job, job.attempts === 1 ? "finish" : "retry"),
        );
        if (state.status === "complete" || state.status === "cancelled") {
          text = state.final;
          break;
        }
        throw new Error(state.error || "Refinement returned no text");
      } catch (error) {
        if (this.stopped(job)) return;
        job.error = String(error).slice(0, 500);
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
        job.retryAt = Date.now() + delay;
        await this.save(job);
        this.deps.log("dictation.refinement_failed", {
          recordingId: job.id,
          attempt: job.attempts,
          error: job.error,
        });
        if (isDictationRecordingUnavailable(error)) break;
        await this.wait(delay);
      }
    }
    if (this.stopped(job)) return;
    if (job.status === "queued") {
      job.usedDraft = !hasSpokenWords(text);
      text = job.usedDraft ? job.draft.trim() : text.trim();
      if (!text) {
        job.status = "empty";
        delete job.retryAt;
        job.error = "No speech was recognized. The original recording is retained.";
        await this.save(job);
        this.deps.log("dictation.no_speech", { recordingId: job.id });
        return;
      }
      job.turn = withMessageText(job.turn, (current) => current.replace(job.marker, () => text));
      job.transcript = text;
      job.status = "ready";
      delete job.error;
      delete job.retryAt;
      await this.save(job);
    }
    let dispatchAttempts = 0;
    while (!this.stopped(job)) {
      try {
        // The orchestrator's durable command receipt prevents duplicates after a
        // crash between dispatch and our sent checkpoint. Never mint a new ID.
        const key = this.key(job.owner, job.id);
        this.active.set(key, "dispatch");
        delete job.error;
        delete job.retryAt;
        try {
          await this.deps.dispatch(job.turn);
        } finally {
          this.active.delete(key);
        }
        job.status = "sent";
        delete job.error;
        await this.save(job);
        this.deps.log("dictation.sent", {
          recordingId: job.id,
          threadId: dictationTurnThreadId(job.turn),
          usedDraft: job.usedDraft,
          attempts: job.attempts,
        });
        return;
      } catch (error) {
        if (this.stopped(job)) return;
        job.error = String(error).slice(0, 500);
        // Missing/expired attachments cannot be repaired by retrying the same
        // immutable request. Keep the transcript for an explicit recovery.
        if (job.error.includes("AttachmentClaimError")) {
          job.status = "abandoned";
          delete job.retryAt;
          await this.save(job);
          return;
        }
        const delay = Math.min(300_000, 1000 * 2 ** Math.min(dispatchAttempts++, 9));
        job.retryAt = Date.now() + delay;
        await this.save(job);
        this.deps.log("dictation.delivery_failed", {
          recordingId: job.id,
          threadId: dictationTurnThreadId(job.turn),
          error: job.error,
        });
        await this.wait(delay);
      }
    }
  }
  async drain() {
    await Promise.all(this.tasks.values());
  }
  async close() {
    this.controller.abort();
    await this.drain();
  }
}
