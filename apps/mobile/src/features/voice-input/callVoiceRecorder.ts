import type { RecorderState, RecordingStatus } from "expo-audio";

import { voiceCall } from "../../native/voiceCall";
import type { NativeVoiceRecorder } from "./lazyVoiceRecorder";

/**
 * The recorder dictation uses while voice mode's call runs: the service's own
 * MediaRecorder, which may start from the background (expo-audio's may not),
 * and records from a Bluetooth headset when one is connected. Same file format
 * as the normal recorder, so the upload is unchanged.
 */
export function createCallVoiceRecorder(): NativeVoiceRecorder<RecordingStatus, RecorderState> {
  const native = voiceCall.native;
  if (!native) throw new Error("Voice mode is not available on this device.");
  let uri: string | null = null;
  const listeners = new Set<(status: RecordingStatus) => void>();
  return {
    get uri() {
      return uri;
    },
    prepareToRecordAsync: async () => {
      uri = native.prepareRecording();
    },
    record: () => {
      void native.startRecording(true).catch((error: unknown) => {
        for (const listener of listeners) {
          listener({
            id: "voice-call",
            isFinished: true,
            hasError: true,
            error: error instanceof Error ? error.message : String(error),
            url: uri,
          });
        }
      });
    },
    stop: () => native.stopRecording(),
    getStatus: () => {
      const status = native.recordingStatus();
      return {
        canRecord: true,
        isRecording: status.isRecording,
        durationMillis: status.durationMillis,
        fileSize: 0,
        mediaServicesDidReset: false,
        metering: status.metering,
        url: uri,
      };
    },
    addListener: (_event, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    getAvailableInputs: () => [],
    setInput: () => undefined,
    release: () => listeners.clear(),
  };
}
