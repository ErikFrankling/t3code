import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import type { VoiceDictationTarget } from "../../native/voiceTranscription";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly label: string;
  readonly dictation?: VoiceDictationTarget;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const global = useGlobalVoiceInput();
  const { session } = global;
  const latestInput = useRef(input);
  // oxlint-disable-next-line react/refs -- Transcription finishes asynchronously and must reach the composer's current selection setter, not the one captured at start.
  latestInput.current = input;
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mount so async transcription results skip a composer that has unmounted
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      session.setOwnerFocused(ownerKey, true);
      return () => session.setOwnerFocused(ownerKey, false);
    }, [input.ownerKey, session]),
  );

  const target = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled) return null;
    return {
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
      ...(captured.dictation ? { dictation: captured.dictation } : {}),
    };
  }, []);
  const start = useCallback(() => {
    const next = target();
    return next ? session.start(next) : Promise.resolve();
  }, [session, target]);
  // A recording kept from a failed stop or from before the app closed: Retry
  // transcribes it into this composer's draft; discarding needs a confirmation.
  const retryFailed = useCallback(() => {
    const next = target();
    return next ? session.retryFailed(next) : Promise.resolve();
  }, [session, target]);
  const discardFailed = useCallback(() => session.controller.discardFailed(), [session]);
  const cancelAndDelete = useCallback(() => session.controller.cancelAndDelete(), [session]);
  // A kept recording found at launch belongs to no composer yet: every composer shows it.
  const unowned = global.ownerKey === null && global.state.phase === "error";
  const state = global.ownerKey === input.ownerKey || unowned ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable: global.isAvailable && (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    retryFailed,
    discardFailed,
    cancelAndDelete,
    failedRecording: session.controller.failedRecording,
    stop: global.stop,
    cancel: global.cancel,
  };
}
