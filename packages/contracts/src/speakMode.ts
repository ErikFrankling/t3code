import * as Schema from "effect/Schema";

/**
 * How the personal agent's `speak` tool treats Erik (one setting for the PC and
 * the phone, kept by the speak daemon, flipped from the personal agent home,
 * the phone's voice-mode card or a key on the PC):
 *
 * - `conversation`: it speaks, then voice input opens for his answer.
 * - `voice-out`: it speaks; voice input never opens by itself. He can still
 *   start a reply. This is the default.
 * - `silent`: nothing is said aloud, text only.
 *
 * The mode wins over what the agent asks for.
 */
export const SpeakMode = Schema.Literals(["conversation", "voice-out", "silent"]);
export type SpeakMode = typeof SpeakMode.Type;

export const SPEAK_MODES: ReadonlyArray<SpeakMode> = ["conversation", "voice-out", "silent"];
export const DEFAULT_SPEAK_MODE: SpeakMode = "voice-out";

export const SPEAK_MODE_LABELS: Record<SpeakMode, string> = {
  conversation: "Conversation",
  "voice-out": "Voice out only",
  silent: "Silent",
};

/** What each mode does, for a tooltip or a caption under the toggle. */
export const SPEAK_MODE_DESCRIPTIONS: Record<SpeakMode, string> = {
  conversation: "Speaks, then opens voice input for your answer.",
  "voice-out": "Speaks, never opens voice input by itself.",
  silent: "Nothing is said aloud, text only.",
};

/** `GET /api/speak-mode`; `POST /api/speak-mode` with `{ mode }` sets it (without `mode` it only reads). */
export const SpeakModeRequest = Schema.Struct({ mode: Schema.optional(SpeakMode) });
export type SpeakModeRequest = typeof SpeakModeRequest.Type;

export const SpeakModeState = Schema.Struct({ mode: SpeakMode });
export type SpeakModeState = typeof SpeakModeState.Type;
