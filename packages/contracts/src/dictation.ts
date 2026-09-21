import { Schema } from "effect";
import { ClientOrchestrationCommand } from "./orchestration.ts";

export const DictationRequest = Schema.Struct({
  action: Schema.Literals(["start", "append", "finish", "retry", "status", "cancel", "send"]),
  id: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  project: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  command: Schema.optional(ClientOrchestrationCommand),
  draft: Schema.optional(Schema.String.check(Schema.isMaxLength(200000))),
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  audio: Schema.optional(Schema.String.check(Schema.isMaxLength(430000))),
});
export type DictationRequest = typeof DictationRequest.Type;
export const DictationState = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["recording", "finalizing", "complete", "error", "cancelled"]),
  draft: Schema.String,
  final: Schema.String,
  error: Schema.String,
  bytes: Schema.Number,
  delivery: Schema.optional(Schema.Literals(["queued", "ready", "sent", "empty"])),
  deliveryError: Schema.optional(Schema.String),
});
export type DictationState = typeof DictationState.Type;
