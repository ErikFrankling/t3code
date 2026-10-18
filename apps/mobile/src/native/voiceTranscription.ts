import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

/** The environment a composer dictates into, and its project for vocabulary. */
export type VoiceDictationTarget = {
  readonly environmentId: EnvironmentId;
  readonly project: string;
};

export type ResolveDictationConnection = () => {
  readonly connection: PreparedConnection;
  readonly project: string;
} | null;

export function getLocalVoiceTranscriber(
  _resolveConnection?: ResolveDictationConnection,
): VoiceTranscriber | null {
  return null;
}
