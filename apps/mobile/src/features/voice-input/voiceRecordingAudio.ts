import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { Platform } from "react-native";

import { voiceCall } from "../../native/voiceCall";

let recordingToken: ReturnType<typeof acquireAudioSession> | null = null;

// During voice mode's call the call owns the audio (mode, route, microphone)
// from start to hang-up; expo-audio's mode calls would reset it every turn.
export async function configureVoiceRecordingAudio(): Promise<void> {
  if (voiceCall.active) return;
  const token = acquireAudioSession("recording");
  recordingToken = token;
  try {
    // Locking the phone or a screen on top (a sign-in, a call) never stops a
    // dictation: expo-audio records on in a foreground service.
    await activateAudioSession(token, false, Platform.OS === "android");
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
