import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { voiceCall } from "../../native/voiceCall";

let recordingToken: ReturnType<typeof acquireAudioSession> | null = null;

// During voice mode's call the call owns the audio (mode, route, microphone)
// from start to hang-up; expo-audio's mode calls would reset it every turn.
export async function configureVoiceRecordingAudio(): Promise<void> {
  if (voiceCall.active) return;
  const token = acquireAudioSession("recording");
  recordingToken = token;
  try {
    await activateAudioSession(token);
  } catch (error) {
    await releaseAudioSession(token).catch(() => {});
    throw error;
  }
}

export async function releaseVoiceRecordingAudio(): Promise<void> {
  const token = recordingToken;
  recordingToken = null;
  if (token) await releaseAudioSession(token);
}
