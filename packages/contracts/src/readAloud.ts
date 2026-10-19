import * as Schema from "effect/Schema";

/**
 * `summary` reads a short spoken rewrite of the message (a local LLM writes
 * it); `full` reads the message itself with markdown and code left out.
 */
export const ReadAloudMode = Schema.Literals(["summary", "full"]);
export type ReadAloudMode = typeof ReadAloudMode.Type;

/**
 * Starts reading a message (`text`, `mode`) or asks how an earlier request is
 * going (`id`). Starting is idempotent: the same text, mode and speed resume
 * the job already made for them. `from` is the first sentence whose audio the
 * client still needs; earlier clips are left out of the reply.
 */
export const ReadAloudRequest = Schema.Struct({
  id: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(200000))),
  mode: Schema.optional(ReadAloudMode),
  /** Multiplies the voice's configured pace; 1 keeps it. */
  speed: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.5), Schema.isLessThanOrEqualTo(2)),
  ),
  from: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type ReadAloudRequest = typeof ReadAloudRequest.Type;

export const ReadAloudSentence = Schema.Struct({
  text: Schema.String,
  /**
   * Base64 WAV on the first sentence of a chunk, covering `span` sentences;
   * present once synthesized and only from the requested index on.
   */
  audio: Schema.optional(Schema.String),
  span: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /** Whether this sentence's audio exists (possibly in an earlier sentence's chunk). */
  ready: Schema.Boolean,
});
export type ReadAloudSentence = typeof ReadAloudSentence.Type;

export const ReadAloudState = Schema.Struct({
  id: Schema.String,
  /** `working` until every sentence is written and synthesized. */
  status: Schema.Literals(["working", "complete", "error"]),
  /** Which voice is speaking, e.g. `big` (Higgs) or `small` (Kokoro). */
  voice: Schema.String,
  sentences: Schema.Array(ReadAloudSentence),
  error: Schema.String,
});
export type ReadAloudState = typeof ReadAloudState.Type;
