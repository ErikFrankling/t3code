// @effect-diagnostics globalFetch:off globalTimers:off -- A plain client of the speak daemon on this machine, like readAloud.ts.
import { SpeakMode, type SpeakModeState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Erik's voice mode for the personal agent's `speak` tool (see the contract).
 * The speak daemon on this machine keeps it, so the PC and the phone read and
 * set the same value; these routes only pass it through. Without a daemon
 * (any machine but Erik's PC) there is no mode: reads give null, sets fail.
 */
const speakUrl = () => process.env.T3CODE_SPEAK_URL || "http://127.0.0.1:8791";

const isSpeakMode = Schema.is(SpeakMode);

async function daemon(body: unknown, timeoutMs: number): Promise<SpeakModeState | null> {
  try {
    const response = await fetch(new URL("/mode", speakUrl()), {
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) return null;
    const state = (await response.json()) as { mode?: unknown };
    return isSpeakMode(state.mode) ? { mode: state.mode } : null;
  } catch {
    return null;
  }
}

/** The current mode, or null when no speak daemon answers. */
export const readSpeakMode = (timeoutMs = 1_500) => daemon(undefined, timeoutMs);

/** Sets the mode; null when the daemon is not there or refused. */
export const writeSpeakMode = (mode: SpeakMode, timeoutMs = 3_000) =>
  daemon({ mode, by: "t3" }, timeoutMs);
