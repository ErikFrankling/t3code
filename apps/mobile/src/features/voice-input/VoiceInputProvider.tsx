import { RegistryContext, useAtomMount } from "@effect/atom-react";
import {
  AudioModule,
  RecordingPresets,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  type RecorderState,
  type RecordingStatus,
} from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useSharedValue } from "react-native-reanimated";

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
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { voiceCall } from "../../native/voiceCall";
import { createCallVoiceRecorder } from "./callVoiceRecorder";
import { configureVoiceRecordingAudio, releaseVoiceRecordingAudio } from "./voiceRecordingAudio";
import { createLazyVoiceRecorder, type LazyVoiceRecorder } from "./lazyVoiceRecorder";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";

const INITIAL_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const VOICE_METERING_INTERVAL_MS = 80;
// The native constructor takes platform-flattened options, as `useAudioRecorder`
// builds them with expo-audio's internal `createRecordingOptions`.
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

const VoiceInputContext = createContext<ReturnType<typeof useVoiceInputRuntime> | null>(null);

export function VoiceInputProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useVoiceInputRuntime();
  return <VoiceInputContext value={runtime}>{children}</VoiceInputContext>;
}

export function useGlobalVoiceInput() {
  const context = use(VoiceInputContext);
  if (!context) throw new Error("Voice input provider is missing.");
  return context;
}

function useVoiceInputRuntime() {
  const registry = use(RegistryContext);
  useAtomMount(mobilePreferencesAtom);
  useAtomMount(updateMobilePreferencesAtom);
  const [{ state, ownerKey, label }, setState] = useState({
    state: INITIAL_STATE,
    ownerKey: null as string | null,
    label: null as string | null,
  });
  const [focusedOwners, setFocusedOwners] = useState<ReadonlySet<string>>(new Set());
  const setOwnerFocused = useCallback((key: string, focused: boolean) => {
    setFocusedOwners((current) => {
      const next = new Set(current);
      if (focused) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const sessionRef = useRef<VoiceInputSession | null>(null);
  const recorderRef = useRef<LazyVoiceRecorder<RecorderState> | null>(null);
  const permissionPromptRef = useRef(false);

  if (!sessionRef.current || !recorderRef.current) {
    const recorder = createLazyVoiceRecorder({
      create: () =>
        voiceCall.active
          ? createCallVoiceRecorder()
          : new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
      onStatus: (status: RecordingStatus) => {
        sessionRef.current?.controller.handleRecorderStatus({
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
    recorderRef.current = recorder;
    const resolveDictationConnection = () => {
      const target = sessionRef.current?.dictation;
      if (!target) return null;
      const connection = () =>
        Option.getOrNull(
          registry.get(environmentSession.preparedConnectionValueAtom(target.environmentId)),
        );
      return { connection, target };
    };
    sessionRef.current = new VoiceInputSession({
      recorder,
      getTranscriber: () => getLocalVoiceTranscriber(resolveDictationConnection),
      requestPermission: async () => {
        // Android shows its permission activity even for a granted permission,
        // which pauses the app; ask only when needed and ignore that pause.
        const current = await getRecordingPermissionsAsync();
        if (current.granted) return { granted: true, canAskAgain: current.canAskAgain };
        permissionPromptRef.current = true;
        try {
          const permission = await requestRecordingPermissionsAsync();
          return { granted: permission.granted, canAskAgain: permission.canAskAgain };
        } finally {
          permissionPromptRef.current = false;
        }
      },
      configureRecording: configureVoiceRecordingAudio,
      // A recording whose transcription failed (no network, the server down)
      // is tried again by itself until its words reach the draft.
      setTimer: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      onStateChange: (nextState) =>
        setState({
          state: nextState,
          ownerKey: sessionRef.current?.ownerKey ?? null,
          label: sessionRef.current?.label ?? null,
        }),
    });
  }

  const session = sessionRef.current;
  const controller = session.controller;
  const recorder = recorderRef.current;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture.
      // In voice mode the call's service keeps recording with the screen off.
      if (nextState === "background" && !permissionPromptRef.current && !voiceCall.active) {
        controller.appMovedToBackground();
      }
    });
    return () => subscription.remove();
  }, [controller]);

  // A recording is deleted only once its words reached the chat or the draft,
  // so any file still here when dictation is idle is one that did not (the app
  // was killed, the phone died, a stop failed): offer it with Retry and Save.
  useEffect(() => {
    if (Platform.OS !== "android" || state.phase !== "idle" || controller.failedRecording) return;
    const kept = keptRecordings();
    const newest = kept[0];
    if (!newest) return;
    controller.adoptKeptRecording(
      newest.uri,
      kept.length > 1
        ? `${kept.length} recordings were kept and not sent yet.`
        : "A recording was kept and not sent yet.",
    );
  }, [controller, state.phase]);

  // The next recording uses the recorder for the mode: the call's own while
  // voice mode runs, expo-audio's otherwise.
  useEffect(() => voiceCall.subscribe(() => recorder.release()), [recorder]);

  useEffect(
    () => () => {
      controller.dispose();
      recorder.release();
    },
    [controller, recorder],
  );

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (!status?.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const nextElapsedSeconds = Math.max(0, Math.floor(status.durationMillis / 1_000));
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  useEffect(() => {
    if (state.phase === "recording") beginDictationStream(recorder.uri, session.ownerKey);
    else if (state.phase === "idle" || state.phase === "error") endDictationStream();
  }, [recorder, session, state.phase]);

  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  return {
    isAvailable: getLocalVoiceTranscriber() !== null || getNativeShowcaseScene() !== null,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    ownerKey,
    label,
    focusedOwners,
    setOwnerFocused,
    session,
    stop,
    cancel,
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
