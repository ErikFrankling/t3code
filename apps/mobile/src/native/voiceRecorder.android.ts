import { AudioModule } from "expo-audio";

// Fork: Android dictation posts the AAC recording to the environment's speech
// service (`/api/dictation/audio`), which decodes it with ffmpeg, so it records
// with expo-audio, not upstream's live PCM recorder.
export function createVoiceRecorder(
  options: ConstructorParameters<typeof AudioModule.AudioRecorder>[0],
) {
  return new AudioModule.AudioRecorder(options);
}
