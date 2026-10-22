import { useAtomValue } from "@effect/atom-react";
import { AudioModule, RecordingPresets, type RecordingStatus } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { makeMutable } from "react-native-reanimated";

import {
  type MicrophoneEntry,
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import {
  beginDictationStream,
  endDictationStream,
  getLocalVoiceTranscriber,
  type ResolveDictationConnection,
} from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentSession } from "../../state/session";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  voiceInputBlocksSubmission,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import { voiceCall } from "../../native/voiceCall";
import { createCallVoiceRecorder } from "./callVoiceRecorder";
import { configureVoiceRecordingAudio, releaseVoiceRecordingAudio } from "./voiceRecordingAudio";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import { createVoiceRecordingPermission } from "./voiceRecordingPermission";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
  // Android dictation uploads the file while it grows, which needs AAC in ADTS
  // (MPEG-4 is unreadable until stopped). Speech needs no more than 16 kHz mono.
  ...(Platform.OS === "android"
    ? {
        // Kept in the app's documents, not the cache Android may clear: a recording
        // survives the app being killed or the phone dying, and is offered again.
        directory: "document" as const,
        extension: ".aac",
        outputFormat: "aac_adts",
        audioEncoder: "aac",
        sampleRate: 16000,
        numberOfChannels: 1,
        bitRate: 48000,
      }
    : {}),
};

function keepScreenAwake(tag: string): () => void {
  const activation = activateKeepAwakeAsync(tag);
  void activation.catch(() => {});
  // Release after activation settles, even if the recording ends immediately.
  return () => void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
}

export const deviceMicrophoneOrder = (saved?: ReadonlyArray<MicrophoneEntry>) =>
  microphoneOrder(saved, Platform.OS === "android" ? "android" : "ios");

/**
 * The composer dictating now, set by the voice input session. Android hands the
 * recording to the environment's speech service, so its transcriber asks this
 * for the connection when a dictation starts.
 */
let currentDictationConnection: ResolveDictationConnection = () => null;

/** "checking" until the first availability probe settles; re-probed on foreground. */
export const localVoiceTranscriberAtom = makePermissionStatusAtom<
  VoiceTranscriber | null | "checking"
>({
  label: "mobile:voice-input:transcriber",
  initial: "checking",
  read: () => getLocalVoiceTranscriber(() => currentDictationConnection()).catch(() => null),
}).pipe(Atom.keepAlive);

// Each foreground re-probe yields a new transcriber; composers re-render only when availability flips.
const localVoiceInputAvailableAtom = Atom.make((get) => {
  const transcriber = get(localVoiceTranscriberAtom);
  return transcriber !== null && transcriber !== "checking";
});

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read and remember microphones synchronously.
  get.mount(mobilePreferencesAtom);
  get.mount(updateMobilePreferencesAtom);
  get.mount(localVoiceTranscriberAtom);
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  const permission = createVoiceRecordingPermission(() => {
    // In voice mode the call's service keeps recording with the screen off.
    if (!voiceCall.active) void session.controller.appMovedToBackground();
  });
  const recorder = createLazyVoiceRecorder({
    create: () =>
      voiceCall.active
        ? createCallVoiceRecorder()
        : new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
    onStatus: (status: RecordingStatus) => {
      session.controller.handleRecorderStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      });
    },
    // Read when recording starts so preference changes do not re-render every composer.
    selectInput: (inputs) => {
      const preferences = registry.get(mobilePreferencesAtom);
      if (!AsyncResult.isSuccess(preferences)) return null;
      const known = deviceMicrophoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(deviceMicrophoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const resolveDictationConnection = () => {
    const target = session.dictation;
    if (!target) return null;
    const connection = () =>
      Option.getOrNull(
        registry.get(environmentSession.preparedConnectionValueAtom(target.environmentId)),
      );
    return { connection, target };
  };
  currentDictationConnection = resolveDictationConnection;
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    getTranscriber: () => {
      const transcriber = registry.get(localVoiceTranscriberAtom);
      return transcriber === "checking" ? null : transcriber;
    },
    requestPermission: permission.requestPermission,
    configureRecording: configureVoiceRecordingAudio,
    // A recording whose transcription failed (no network, the server down)
    // is tried again by itself until its words reach the draft.
    setTimer: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    releaseRecording: releaseVoiceRecordingAudio,
    deleteRecording: (uri) => new File(uri).delete(),
    sampleRecording: () => {
      const status = recorder.getStatus();
      return status?.isRecording
        ? { durationMillis: status.durationMillis, metering: status.metering }
        : null;
    },
    publishAudioLevels: (levels) => audioLevels.set(levels),
    keepAwake: () => keepScreenAwake(`voice-input:${++keepAwakeSequence}`),
  });
  // Android uploads the growing recording so the live draft shows while you talk.
  let streamPhase = session.getSnapshot().state.phase;
  const unsubscribeStream = session.subscribe(() => {
    const phase = session.getSnapshot().state.phase;
    if (phase === streamPhase) return;
    streamPhase = phase;
    if (phase === "recording") beginDictationStream(recorder.uri, session.ownerKey);
    else if (phase === "idle" || phase === "error") endDictationStream();
    if (phase === "idle") offerKeptRecording();
  });
  // A recording is deleted only once its words reached the chat or the draft,
  // so any file still here when dictation is idle is one that did not (the app
  // was killed, the phone died, a stop failed): offer it with Retry and Save.
  const offerKeptRecording = () => {
    const controller = session.controller;
    if (Platform.OS !== "android" || controller.currentState.phase !== "idle") return;
    if (controller.failedRecording) return;
    const kept = keptRecordings();
    const newest = kept[0];
    if (!newest) return;
    controller.adoptKeptRecording(
      newest.uri,
      // Short enough for two lines beside Retry, Save and the send button.
      kept.length > 1 ? `${kept.length} recordings saved, not sent.` : "Recording saved, not sent.",
    );
  };
  offerKeptRecording();
  // The next recording uses the recorder for the mode: the call's own while
  // voice mode runs, expo-audio's otherwise.
  const unsubscribeVoiceCall = voiceCall.subscribe(() => recorder.release());
  get.addFinalizer(() => {
    unsubscribeStream();
    unsubscribeVoiceCall();
    permission.dispose();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const isTranscriberAvailable = useAtomValue(localVoiceInputAvailableAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snapshot,
    isAvailable: isTranscriberAvailable || getNativeShowcaseScene() !== null,
    audioLevels,
    isBusy: voiceInputBlocksSubmission(snapshot.state),
    session,
    stop: () => session.controller.stop(),
    cancel: () => session.controller.cancel(),
  };
}

/** Recordings on the device that were never sent or put into a draft, newest first. */
function keptRecordings(): File[] {
  const files: File[] = [];
  const add = (directory: Directory, match: (name: string) => boolean) => {
    try {
      if (!directory.exists) return;
      for (const entry of directory.list()) {
        if (entry instanceof File && match(entry.name) && (entry.size ?? 0) > 0) files.push(entry);
      }
    } catch {}
  };
  add(new Directory(Paths.document, "Audio"), (name) => name.endsWith(".aac"));
  // Where recordings were kept before (the cache), in case an old one survived.
  add(new Directory(Paths.cache, "Audio"), (name) => name.endsWith(".aac"));
  // Voice mode's turns (they were kept in the cache before).
  add(
    new Directory(Paths.cache),
    (name) => name.startsWith("voice-call-") && name.endsWith(".aac"),
  );
  return files.sort((a, b) => (b.modificationTime ?? 0) - (a.modificationTime ?? 0));
}
