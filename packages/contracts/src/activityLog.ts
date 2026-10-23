import * as Schema from "effect/Schema";

const Iso = Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(40));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/**
 * One finished piece of listening or attention, kept for Erik's Time tracker
 * (`time-collect` reads the table). Read-aloud may name just the message; the
 * server finds its thread.
 */
export const ActivityEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("t3.readaloud.played"),
    messageId: Id,
    threadId: Schema.optional(Id),
    client: Schema.String.check(Schema.isMaxLength(32)),
    startedAt: Iso,
    endedAt: Iso,
    /** Time spent actually playing, not paused. */
    seconds: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    kind: Schema.Literal("t3.voicemode.span"),
    threadId: Schema.optional(Id),
    client: Schema.String.check(Schema.isMaxLength(32)),
    startedAt: Iso,
    endedAt: Iso,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread.focus"),
    threadId: Id,
    client: Schema.String.check(Schema.isMaxLength(32)),
    at: Iso,
  }),
]);
export type ActivityEvent = typeof ActivityEvent.Type;
