import { useAtomValue } from "@effect/atom-react";
import {
  AudioModule,
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  type RecordingStatus,
} from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { makeMutable } from "react-native-reanimated";

import {
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import {
  beginDictationStream,
  endDictationStream,
  getLocalVoiceTranscriber,
} from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentSession } from "../../state/session";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import { voiceInputBlocksSubmission } from "@t3tools/client-runtime/voice-input";
import { voiceCall } from "../../native/voiceCall";
import { createCallVoiceRecorder } from "./callVoiceRecorder";
import { createLazyVoiceRecorder } from "./lazyVoiceRecorder";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";

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

/**
 * The app has one microphone and one dictation at a time, so the session
 * lives for the registry's lifetime rather than any screen's.
 */
const voiceInputAtom = Atom.make((get) => {
  const registry = get.registry;
  // Mounted so the recorder can read and remember microphones synchronously.
  get.mount(mobilePreferencesAtom);
  get.mount(updateMobilePreferencesAtom);
  const audioLevels = makeMutable<ReadonlyArray<number>>(
    Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0),
  );
  let keepAwakeSequence = 0;
  let permissionPrompt = false;
  let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
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
      const known = microphoneOrder(preferences.value.microphones);
      const order = rememberMicrophones(known, inputs);
      if (order !== known) {
        registry.set(updateMobilePreferencesAtom, {
          transform: (current) => ({
            microphones: rememberMicrophones(microphoneOrder(current.microphones), inputs),
          }),
        });
      }
      return preferredMicrophoneInput(inputs, order);
    },
  });
  const resolveDictationConnection = () => {
    const target = session.dictation;
    if (!target) return null;
    const connection = Option.getOrNull(
      registry.get(environmentSession.preparedConnectionValueAtom(target.environmentId)),
    );
    return connection ? { connection, target } : null;
  };
  const session: VoiceInputSession = new VoiceInputSession({
    recorder,
    getTranscriber: () => getLocalVoiceTranscriber(resolveDictationConnection),
    requestPermission: async () => {
      // Android shows its permission activity even for a granted permission,
      // which pauses the app; ask only when needed and ignore that pause.
      const current = await getRecordingPermissionsAsync();
      if (current.granted) return { granted: true, canAskAgain: current.canAskAgain };
      permissionPrompt = true;
      try {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      } finally {
        permissionPrompt = false;
      }
    },
    configureRecording: async () => {
      const token = acquireAudioSession("recording");
      audioToken = token;
      try {
        await activateAudioSession(token);
      } catch (error) {
        await releaseAudioSession(token).catch(() => {});
        throw error;
      }
    },
    releaseRecording: async () => {
      if (audioToken) await releaseAudioSession(audioToken);
      audioToken = null;
    },
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
  // iOS reports `inactive` while its permission dialog is open. Only the real
  // background state cancels preparation; recorder status handles calls and
  // route interruptions during capture.
  const appStateSubscription = AppState.addEventListener("change", (nextState) => {
    // In voice mode the call's service keeps recording with the screen off.
    if (nextState === "background" && !permissionPrompt && !voiceCall.active) {
      void session.controller.appMovedToBackground();
    }
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
      kept.length > 1
        ? `${kept.length} recordings were kept and not sent yet.`
        : "A recording was kept and not sent yet.",
    );
  };
  offerKeptRecording();
  // The next recording uses the recorder for the mode: the call's own while
  // voice mode runs, expo-audio's otherwise.
  const unsubscribeVoiceCall = voiceCall.subscribe(() => recorder.release());
  get.addFinalizer(() => {
    unsubscribeStream();
    unsubscribeVoiceCall();
    appStateSubscription.remove();
    session.dispose();
    recorder.release();
  });
  return { session, audioLevels };
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:voice-input"));

export function useGlobalVoiceInput() {
  const { session, audioLevels } = useAtomValue(voiceInputAtom);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snapshot,
    isAvailable: getLocalVoiceTranscriber() !== null || getNativeShowcaseScene() !== null,
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
