import * as Schema from "effect/Schema";
import { OrchestrationV2Command, OrchestrationV2ThreadLaunchInput } from "./orchestrationV2.ts";

/** Speech actions the host forwards to the local speech service. */
export const DictationRequest = Schema.Struct({
  action: Schema.Literals(["start", "append", "finish", "retry", "status", "cancel"]),
  id: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  project: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  draft: Schema.optional(Schema.String.check(Schema.isMaxLength(200000))),
  sequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  audio: Schema.optional(Schema.String.check(Schema.isMaxLength(430000))),
});
export type DictationRequest = typeof DictationRequest.Type;

export const DictationDeliveryStatus = Schema.Literals([
  "queued",
  "ready",
  "sent",
  "empty",
  "abandoned",
]);
export type DictationDeliveryStatus = typeof DictationDeliveryStatus.Type;

export const DictationState = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["recording", "finalizing", "complete", "error", "cancelled"]),
  draft: Schema.String,
  final: Schema.String,
  error: Schema.String,
  bytes: Schema.Number,
  delivery: Schema.optional(DictationDeliveryStatus),
  deliveryError: Schema.optional(Schema.String),
});
export type DictationState = typeof DictationState.Type;

/**
 * The turn a stopped recording becomes: the same request a typed send would
 * make, held by the server until the final transcript replaces the marker
 * `[dictation:<id>]` in its message text.
 */
export const DictationTurn = Schema.Union([
  Schema.Struct({ method: Schema.Literal("dispatchCommand"), command: OrchestrationV2Command }),
  Schema.Struct({
    method: Schema.Literal("launchThread"),
    input: OrchestrationV2ThreadLaunchInput,
  }),
]);
export type DictationTurn = typeof DictationTurn.Type;

export const DictationDeliverInput = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(64)),
  draft: Schema.String.check(Schema.isMaxLength(200000)),
  turn: DictationTurn,
});
export type DictationDeliverInput = typeof DictationDeliverInput.Type;

export const DictationDeliverResult = Schema.Struct({
  id: Schema.String,
  delivery: DictationDeliveryStatus,
});
export type DictationDeliverResult = typeof DictationDeliverResult.Type;

export const dictationMarker = (id: string) => `[dictation:${id}]`;
