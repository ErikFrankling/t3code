import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DictationState, ThreadTurnStartCommand } from "@t3tools/contracts";

type Turn = typeof ThreadTurnStartCommand.Type;
export interface DeliveryJob {
  id: string;
  owner: string;
  command: Turn;
  marker: string;
  draft: string;
  attempts: number;
  status: "queued" | "ready" | "sent" | "empty";
  usedDraft?: boolean;
  error?: string;
}
interface Dependencies {
  directory: string;
  speech: (
    owner: string,
    id: string,
    action: "finish" | "retry" | "status",
  ) => Promise<DictationState>;
  dispatch: (command: Turn) => Promise<unknown>;
  log: (event: string, fields: Record<string, unknown>) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Persist the destination and immutable command before acknowledging Stop. */
export class DictationDeliveryQueue {
  private readonly jobs = new Map<string, DeliveryJob>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  private mutation = Promise.resolve();
  private readonly deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  private key(owner: string, id: string) {
    return createHash("sha256")
      .update(JSON.stringify([owner, id]))
      .digest("hex");
  }
  private async save(job: DeliveryJob) {
    const file = join(this.deps.directory, `${this.key(job.owner, job.id)}.json`);
    const checkpoint = await open(`${file}.new`, "w", 0o600);
    try {
      await checkpoint.writeFile(JSON.stringify(job));
      await checkpoint.sync();
    } finally {
      await checkpoint.close();
    }
    await rename(`${file}.new`, file);
    const directory = await open(this.deps.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async start() {
    await mkdir(this.deps.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.deps.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const job: DeliveryJob = JSON.parse(
          await readFile(join(this.deps.directory, name), "utf8"),
        );
        if (
          typeof job.owner !== "string" ||
          typeof job.id !== "string" ||
          !job.command?.threadId ||
          !Number.isInteger(job.attempts) ||
          !["queued", "ready", "sent", "empty"].includes(job.status)
        ) {
          throw new Error("Invalid delivery checkpoint");
        }
        this.jobs.set(this.key(job.owner, job.id), job);
        this.launch(job, true);
      } catch (error) {
        this.deps.log("dictation.checkpoint_failed", { file: name, error: String(error) });
      }
    }
  }
  get(owner: string, id: string) {
    return this.jobs.get(this.key(owner, id));
  }
  async enqueue(input: Omit<DeliveryJob, "attempts" | "status">) {
    const operation = this.mutation.then(async () => {
      const existing = this.get(input.owner, input.id);
      if (existing) {
        if (existing.command.threadId !== input.command.threadId)
          throw new Error("Recording already belongs to another chat.");
        return existing;
      }
      const job: DeliveryJob = { ...input, attempts: 0, status: "queued" };
      await this.save(job);
      this.jobs.set(this.key(job.owner, job.id), job);
      this.deps.log("dictation.queued", { recordingId: job.id, threadId: job.command.threadId });
      this.launch(job);
      return job;
    });
    this.mutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  private launch(job: DeliveryJob, resumed = false) {
    const key = this.key(job.owner, job.id);
    if (job.status === "sent" || job.status === "empty" || this.tasks.has(key)) return;
    const task = this.run(job, resumed)
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
      : delay(ms, undefined, { signal: this.controller.signal });
  }
  private async settledState(job: DeliveryJob, initial: DictationState) {
    let state = initial;
    const deadline = Date.now() + 10 * 60_000;
    while (true) {
      if (state.draft.trim()) job.draft = state.draft;
      if (state.status !== "recording" && state.status !== "finalizing") return state;
      if (Date.now() > deadline) throw new Error("Refinement deadline exceeded");
      await this.wait(800);
      state = await this.deps.speech(job.owner, job.id, "status");
    }
  }
  private async run(job: DeliveryJob, resumed: boolean) {
    let text = "";
    // A process restart can happen after refinement finishes but before its
    // result is checkpointed. Recover that result before spending another try.
    if (resumed && job.status === "queued" && job.attempts > 0) {
      try {
        let state = await this.deps.speech(job.owner, job.id, "status");
        if (state.status === "finalizing") state = await this.settledState(job, state);
        if (state.draft.trim()) job.draft = state.draft;
        if (state.status === "complete") text = state.final;
      } catch (error) {
        this.deps.log("dictation.recovery_failed", { recordingId: job.id, error: String(error) });
      }
    }
    while (
      !text.trim() &&
      job.status === "queued" &&
      job.attempts < 3 &&
      !this.controller.signal.aborted
    ) {
      job.attempts++;
      await this.save(job);
      this.deps.log("dictation.refinement_attempt", { recordingId: job.id, attempt: job.attempts });
      try {
        const state = await this.settledState(
          job,
          await this.deps.speech(job.owner, job.id, job.attempts === 1 ? "finish" : "retry"),
        );
        if (state.status === "complete" && state.final.trim()) {
          text = state.final;
          break;
        }
        throw new Error(state.error || "Refinement returned no text");
      } catch (error) {
        if (this.controller.signal.aborted) return;
        job.error = String(error).slice(0, 500);
        await this.save(job);
        this.deps.log("dictation.refinement_failed", {
          recordingId: job.id,
          attempt: job.attempts,
          error: job.error,
        });
        if (job.attempts < 3) await this.wait(job.attempts * 2000);
      }
    }
    if (this.controller.signal.aborted) return;
    if (job.status === "queued") {
      job.usedDraft = !text.trim();
      text = text.trim() || job.draft.trim();
      if (!text) {
        job.status = "empty";
        job.error = "No speech was recognized. The original recording is retained.";
        await this.save(job);
        this.deps.log("dictation.no_speech", { recordingId: job.id });
        return;
      }
      job.command = {
        ...job.command,
        message: {
          ...job.command.message,
          text: job.command.message.text.replace(job.marker, () => text),
        },
      };
      job.status = "ready";
      await this.save(job);
    }
    let dispatchAttempts = 0;
    while (!this.controller.signal.aborted) {
      try {
        // The engine's durable command receipt prevents duplicates after a crash
        // between dispatch and our sent checkpoint. Never mint a new command ID.
        await this.deps.dispatch(job.command);
        job.status = "sent";
        delete job.error;
        await this.save(job);
        this.deps.log("dictation.sent", {
          recordingId: job.id,
          threadId: job.command.threadId,
          usedDraft: job.usedDraft,
          attempts: job.attempts,
        });
        return;
      } catch (error) {
        job.error = String(error).slice(0, 500);
        await this.save(job);
        this.deps.log("dictation.delivery_failed", {
          recordingId: job.id,
          threadId: job.command.threadId,
          error: job.error,
        });
        await this.wait(Math.min(30_000, 1000 * 2 ** Math.min(dispatchAttempts++, 5)));
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
