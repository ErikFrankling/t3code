import * as Schema from "effect/Schema";

/** Cancellation is cooperative: settle only after the underlying work has stopped. */
export type VoiceTranscriptionOptions = {
  readonly signal: AbortSignal;
};

export type VoiceStreamingSession = {
  readonly finish: (options: VoiceTranscriptionOptions) => Promise<string>;
};

export type PreparedVoiceTranscription = {
  readonly locale: string;
  readonly start?: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>;
  readonly transcribe: (uri: string, options: VoiceTranscriptionOptions) => Promise<string>;
  /** Present when audio streams during capture; `finish` then replaces `transcribe`. */
  readonly streaming?: VoiceStreamingSession;
  /**
   * Hands the stopped recording to the environment, which transcribes it and
   * sends the message itself (as the web composer does). When present it
   * replaces `transcribe`: it resolves `null` once the environment owns the
   * message, or a transcript to insert into the draft when sending was refused.
   */
  readonly deliver?: (uri: string, options: VoiceTranscriptionOptions) => Promise<string | null>;
};

export type VoiceTranscriber = {
  readonly prepare: (options: VoiceTranscriptionOptions) => Promise<PreparedVoiceTranscription>;
};

const VoiceTranscriptionErrorCode = Schema.Literals([
  "unavailable",
  "unsupported-locale",
  "preparation-failed",
  "transcription-failed",
  "cancelled",
]);
export type VoiceTranscriptionErrorCode = typeof VoiceTranscriptionErrorCode.Type;

export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    code: VoiceTranscriptionErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export function throwIfVoiceTranscriptionAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VoiceTranscriptionError({
      code: "cancelled",
      message: "Voice transcription was cancelled.",
    });
  }
}
