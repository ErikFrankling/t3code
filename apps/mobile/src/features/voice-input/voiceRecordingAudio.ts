import { setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import { Platform } from "react-native";

import { voiceCall } from "../../native/voiceCall";

// During voice mode's call the call owns the audio (mode, route, microphone)
// from start to hang-up; expo-audio's mode calls would reset it every turn.
export async function releaseVoiceRecordingAudio(): Promise<void> {
  if (voiceCall.active) return;
  try {
    await setAudioModeAsync({ allowsRecording: false, shouldPlayInBackground: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

export async function configureVoiceRecordingAudio(): Promise<void> {
  if (voiceCall.active) return;
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      // Locking the phone or a screen on top (a sign-in, a call) never stops a
      // dictation: expo-audio records on in a foreground service.
      allowsBackgroundRecording: Platform.OS === "android",
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {}
    throw error;
  }
}
