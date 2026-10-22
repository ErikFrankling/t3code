import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

/** A stopped recording, handed to the composer's send. */
export type DictatedMessage = { readonly id: string; readonly draft: string };

/**
 * The environment a composer dictates into and its project for vocabulary.
 * `send` queues the message with the recording's marker; the server sends it
 * once the final transcript exists. Without it the transcript is inserted.
 */
export type VoiceDictationTarget = {
  readonly environmentId: EnvironmentId;
  readonly project: string;
  readonly send?: (recording: DictatedMessage) => Promise<boolean>;
};

/**
 * The composer dictating now. Its connection is read when needed, so a recording
 * started offline uploads once the phone is back online.
 */
export type ResolveDictationConnection = () => {
  readonly connection: () => PreparedConnection | null;
  readonly target: VoiceDictationTarget;
} | null;

export function getLocalVoiceTranscriber(
  _resolveConnection?: ResolveDictationConnection,
): VoiceTranscriber | null {
  return null;
}

/** Android streams the recording to the environment while it is made; elsewhere a no-op. */
export function beginDictationStream(_uri: string | null, _ownerKey: string | null): void {}

export function endDictationStream(): void {}
