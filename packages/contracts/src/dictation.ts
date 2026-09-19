import { Schema } from "effect";

export const DictationRequest = Schema.Struct({
  action: Schema.Literals(["start", "append", "finish", "retry", "status", "cancel"]),
  id: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  project: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
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
});
export type DictationState = typeof DictationState.Type;
