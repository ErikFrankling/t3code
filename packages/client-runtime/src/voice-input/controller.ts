import { replaceTextRange } from "@t3tools/shared/composerTrigger";

import type { PreparedVoiceTranscription, VoiceTranscriber } from "./transcription.ts";

export type VoiceInputPhase = "idle" | "preparing" | "recording" | "transcribing" | "error";

export type VoiceInputState = {
  readonly phase: VoiceInputPhase;
  readonly error: string | null;
  readonly errorAction: "retry" | "settings" | null;
  /** A recording on hold: the microphone is off, and Resume continues the same recording. */
  readonly paused?: boolean;
};

export function voiceInputBlocksSubmission(state: VoiceInputState): boolean {
  return (
    state.phase === "preparing" || state.phase === "recording" || state.phase === "transcribing"
  );
}

export type VoiceDraftSnapshot = {
  readonly ownerKey: string;
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly revision: number;
};

export type VoiceRecorderStatus = {
  readonly isFinished: boolean;
  readonly hasError: boolean;
  readonly error: string | null;
  readonly url: string | null;
};

export interface VoiceRecorder {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  // No duration: a recording lasts until the user stops it (Erik talks for
  // half an hour; a native cap used to stop and send mid-sentence at 5 min).
  record(): void;
  stop(): Promise<void>;
  /** Holds the recording; `resume` continues the same file. Without them there is no pause. */
  pause?(): void;
  resume?(): void;
}

export type VoiceInputControllerDependencies = {
  readonly recorder: VoiceRecorder;
  readonly getTranscriber: () => VoiceTranscriber | null;
  readonly requestPermission: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  readonly configureRecording: () => Promise<void>;
  readonly releaseRecording: () => Promise<void>;
  readonly deleteRecording: (uri: string) => void;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
  /**
   * Runs `run` after `ms` and returns a cancel. With it, a recording whose
   * transcription failed (no network, the server down) is tried again by
   * itself; without it, it waits for Retry.
   */
  readonly setTimer?: (run: () => void, ms: number) => () => void;
};

// Waits between automatic retries of a failed recording; the last repeats.
const AUTO_RETRY_NOTICE = "Saved, retrying by itself.";
const AUTO_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000] as const;

type TranscriptCommitResult =
  | {
      readonly kind: "commit";
      readonly text: string;
      readonly selection: { readonly start: number; readonly end: number };
    }
  | { readonly kind: "stale" }
  | { readonly kind: "empty" };

export function resolveTranscriptCommit(
  captured: VoiceDraftSnapshot,
  current: VoiceDraftSnapshot | null,
  transcript: string,
  locale: string,
): TranscriptCommitResult {
  if (
    !current ||
    current.ownerKey !== captured.ownerKey ||
    current.text !== captured.text ||
    current.revision !== captured.revision
  ) {
    return { kind: "stale" };
  }

  const replacement = transcript.trim();
  if (replacement.length === 0) {
    return { kind: "empty" };
  }

  const isEmptySelection = captured.selection.start === captured.selection.end;
  const normalizedLocale = locale.replaceAll("_", "-").toLowerCase();
  const usesEnglishSpacing = normalizedLocale === "en" || normalizedLocale.startsWith("en-");
  let insertion = replacement;
  if (isEmptySelection && usesEnglishSpacing) {
    const left = captured.text[captured.selection.start - 1];
    const right = captured.text[captured.selection.start];
    const leftNeedsBoundary =
      left !== undefined &&
      /[A-Za-z0-9.!?,:;)\]}'"]/.test(left) &&
      (right === undefined || /\s/.test(right));
    const rightNeedsBoundary =
      right !== undefined &&
      /[A-Za-z0-9([{'"]/.test(right) &&
      (left === undefined || /\s/.test(left));
    insertion = `${leftNeedsBoundary ? " " : ""}${replacement}${rightNeedsBoundary ? " " : ""}`;
  }

  const result = replaceTextRange(
    captured.text,
    captured.selection.start,
    captured.selection.end,
    insertion,
  );
  return {
    kind: "commit",
    text: result.text,
    selection: { start: result.cursor, end: result.cursor },
  };
}

type VoiceInputSession = {
  abandoned: boolean;
  readonly released: Promise<void>;
  readonly release: () => void;
};

let activeSession: VoiceInputSession | null = null;
let activeTranscriptionOperation: Promise<unknown> | null = null;

function acquireSession(): VoiceInputSession | null {
  if (activeSession) return null;
  const { promise, resolve } = Promise.withResolvers<void>();
  const token = { abandoned: false, released: promise, release: resolve };
  activeSession = token;
  return token;
}

function releaseSession(token: VoiceInputSession | null): void {
  if (token && activeSession === token) {
    activeSession = null;
    token.release();
  }
}

async function runTranscriptionOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeTranscriptionOperation) {
    throw new Error("voice-operation-busy");
  }

  const promise = operation();
  activeTranscriptionOperation = promise;
  try {
    return await promise;
  } finally {
    if (activeTranscriptionOperation === promise) activeTranscriptionOperation = null;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function preparationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  if (errorCode(error) === "unsupported-locale") {
    return "Voice transcription is not available for this language.";
  }
  return "Could not prepare voice transcription.";
}

function transcriptionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  return "Could not transcribe this recording.";
}

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export class VoiceInputController {
  private readonly dependencies: VoiceInputControllerDependencies;
  private state: VoiceInputState = IDLE_STATE;
  private operationToken = 0;
  private sessionToken: VoiceInputSession | null = null;
  private transcription: PreparedVoiceTranscription | null = null;
  private transcriptionAbortController: AbortController | null = null;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private recordingUri: string | null = null;
  private readonly ownedRecordingUris = new Set<string>();
  // Recordings stay on the device unless their words were delivered or committed.
  private keepRecordings = true;
  // The recording a failed stop left behind (kept on the device): Retry or Save it.
  private failed: string | null = null;
  private recordingConfigured = false;
  private finishing = false;
  private cancelAutoRetry: (() => void) | null = null;
  private autoRetries = 0;
  // The draft the failed recording belongs to: retries wait until it is open.
  private retryOwner: string | null = null;

  constructor(dependencies: VoiceInputControllerDependencies) {
    this.dependencies = dependencies;
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    const initiatingDraft = this.dependencies.readDraft();
    if (!initiatingDraft) {
      this.setError("This draft is no longer available.", "retry");
      return;
    }
    let sessionToken: VoiceInputSession | null = null;
    const operationToken = ++this.operationToken;
    this.setState({ phase: "preparing", error: null, errorAction: null });

    try {
      for (
        let previousSession = activeSession;
        previousSession?.abandoned;
        previousSession = activeSession
      ) {
        await previousSession.released;
        if (!this.isCurrent(operationToken)) return;
      }
      sessionToken = acquireSession();
      if (!sessionToken) {
        this.setError("Another voice recording is already active.", "retry");
        return;
      }
      this.sessionToken = sessionToken;
      const abortController = new AbortController();
      this.transcriptionAbortController = abortController;

      const transcriber = this.dependencies.getTranscriber();
      if (!transcriber) {
        this.setError("Voice transcription is not available.", null);
        return;
      }

      const permission = await this.dependencies.requestPermission();
      if (!this.isCurrent(operationToken)) return;
      if (!permission.granted) {
        this.setError(
          "Microphone access is required for voice input.",
          permission.canAskAgain ? "retry" : "settings",
        );
        return;
      }

      try {
        this.transcription = await runTranscriptionOperation(() =>
          transcriber.prepare({ signal: abortController.signal }),
        );
      } catch (error) {
        if (this.isCurrent(operationToken)) this.setError(preparationErrorMessage(error), "retry");
        return;
      }
      if (!this.isCurrent(operationToken)) return;

      await this.dependencies.configureRecording();
      this.recordingConfigured = true;
      if (!this.isCurrent(operationToken)) return;
      await this.dependencies.recorder.prepareToRecordAsync();
      if (!this.isCurrent(operationToken)) return;
      this.recordingUri = this.dependencies.recorder.uri;
      this.rememberRecordingUri(this.recordingUri);

      const capturedDraft = this.dependencies.readDraft();
      if (!capturedDraft || capturedDraft.ownerKey !== initiatingDraft.ownerKey) {
        this.setError("This draft is no longer available.", "retry");
        return;
      }
      this.capturedDraft = capturedDraft;
      this.dependencies.recorder.record();
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch {
      if (this.isCurrent(operationToken))
        this.setError("Could not start voice recording.", "retry");
    } finally {
      if (sessionToken && this.sessionToken === sessionToken) {
        if (this.isCurrent(operationToken) && this.state.phase === "error") {
          await this.releaseResources();
        } else if (!this.isCurrent(operationToken) && !this.finishing) {
          await this.releaseResources();
        }
      }
    }
  }

  stop(): Promise<void> {
    if (this.state.phase !== "recording") return Promise.resolve();
    return this.finishRecording(false, null);
  }

  /** Stops and puts the words into the draft to edit, where Stop would send them. */
  stopToDraft(): Promise<void> {
    if (this.state.phase !== "recording") return Promise.resolve();
    return this.finishRecording(false, null, "draft");
  }

  get canPause(): boolean {
    const recorder = this.dependencies.recorder;
    return typeof recorder.pause === "function" && typeof recorder.resume === "function";
  }

  /** Holds the recording: the microphone stops, nothing is sent or lost. */
  pause(): void {
    if (this.state.phase !== "recording" || this.state.paused || !this.canPause) return;
    this.dependencies.recorder.pause?.();
    this.setState({ ...this.state, paused: true });
  }

  /** Continues a paused recording in the same file. */
  resume(): void {
    if (this.state.phase !== "recording" || !this.state.paused) return;
    this.dependencies.recorder.resume?.();
    this.setState({ ...this.state, paused: false });
  }

  cancel(): void {
    switch (this.state.phase) {
      case "idle":
        return;
      case "error":
        this.setState(IDLE_STATE);
        return;
      case "preparing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
      case "recording":
        this.discardRecording(null);
        return;
      case "transcribing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
    }
  }

  /**
   * Something stopped the recording (the recorder failed, the system ended it).
   * The words are kept: what was recorded is transcribed into the draft (never
   * sent on its own), and the audio is deleted only once that worked.
   */
  interruptRecording(
    _message = "Voice recording was interrupted.",
    completedUri: string | null = null,
  ): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    this.rememberRecordingUri(completedUri);
    this.recordingUri = completedUri ?? this.recordingUri;
    return this.finishRecording(true, completedUri, "draft");
  }

  /**
   * Leaving the app (locking the phone, a sign-in screen on top) never stops a
   * recording: the recorder keeps going in the background. Only a recording that
   * had not started yet is abandoned.
   */
  appMovedToBackground(): Promise<void> | void {
    if (this.state.phase === "preparing") {
      this.invalidateOperation();
      this.setError("Voice input stopped when the app moved to the background.", "retry");
    }
  }

  handleRecorderStatus(status: VoiceRecorderStatus): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    if (status.hasError) {
      return this.interruptRecording(
        status.error ?? "Voice recording was interrupted.",
        status.url,
      );
    }
    if (status.isFinished) {
      if (!status.url) {
        return this.interruptRecording();
      }
      return this.finishRecording(true, status.url);
    }
  }

  ownerChanged(): void {
    if (this.state.phase === "idle") return;
    this.cancel();
  }

  dispose(): void {
    this.stopRetrying();
    if (this.state.phase === "recording") {
      this.discardRecording(null);
      return;
    }
    if (this.state.phase === "preparing" || this.state.phase === "transcribing") {
      this.invalidateOperation();
      this.setState(IDLE_STATE);
    }
  }

  private async finishRecording(
    alreadyStopped: boolean,
    completedUri: string | null,
    // `draft`: put the transcript into the draft even where Stop would send it.
    destination: "default" | "draft" = "default",
  ): Promise<void> {
    if (this.finishing || this.state.phase !== "recording") return;
    this.finishing = true;
    const operationToken = this.operationToken;
    this.setState({ phase: "transcribing", error: null, errorAction: null });

    try {
      if (!alreadyStopped) await this.dependencies.recorder.stop();
      await this.releaseAudioSession();
      this.recordingUri = completedUri ?? this.dependencies.recorder.uri ?? this.recordingUri;
      this.rememberRecordingUri(this.recordingUri);
      if (!this.isCurrent(operationToken)) return;
      if (
        !this.recordingUri ||
        !this.transcription ||
        !this.transcriptionAbortController ||
        !this.capturedDraft
      ) {
        this.setError("Could not finish voice recording.", "retry");
        return;
      }

      const recordingUri = this.recordingUri;
      const transcription = this.transcription;
      const signal = this.transcriptionAbortController.signal;
      const capturedDraft = this.capturedDraft;
      let transcript: string;
      try {
        if (transcription.deliver && destination === "default") {
          const deliver = transcription.deliver;
          const fallback = await runTranscriptionOperation(() => deliver(recordingUri, { signal }));
          if (fallback === null) {
            this.keepRecordings = false;
            if (this.isCurrent(operationToken)) this.setState(IDLE_STATE);
            return;
          }
          transcript = fallback;
        } else {
          transcript = await runTranscriptionOperation(() =>
            transcription.transcribe(recordingUri, { signal }),
          );
        }
      } catch (error) {
        this.failed = recordingUri;
        if (this.isCurrent(operationToken)) {
          this.setError(transcriptionErrorMessage(error), "retry");
        }
        this.retryLater();
        return;
      }
      if (!this.isCurrent(operationToken)) return;

      const result = resolveTranscriptCommit(
        capturedDraft,
        this.dependencies.readDraft(),
        transcript,
        transcription.locale,
      );
      if (result.kind === "stale") {
        this.failed = recordingUri;
        this.setError(
          "The draft changed while voice input was running. The transcript was not added.",
          "retry",
        );
        return;
      }
      if (result.kind === "empty") {
        this.failed = recordingUri;
        this.setError("No speech was detected.", "retry");
        return;
      }

      this.dependencies.commitDraft(result.text, result.selection);
      this.keepRecordings = false;
      this.setState(IDLE_STATE);
    } catch {
      this.failed = this.recordingUri;
      if (this.isCurrent(operationToken)) {
        this.setError("Could not finish voice recording.", "retry");
      }
      this.retryLater();
    } finally {
      this.finishing = false;
      await this.releaseResources();
    }
  }

  /** The kept recording of a failed stop, if any (a file on the device). */
  get failedRecording(): string | null {
    return this.failed;
  }

  /**
   * Transcribes the kept recording again (as a new upload) and puts the words
   * into the draft. The file is deleted only once that worked.
   */
  async retryFailed(): Promise<void> {
    const uri = this.failed;
    if (!uri || this.state.phase === "recording" || this.state.phase === "transcribing") return;
    const transcriber = this.dependencies.getTranscriber();
    if (!transcriber) return;
    const controller = new AbortController();
    this.setState({ phase: "transcribing", error: null, errorAction: null });
    try {
      const prepared = await transcriber.prepare({ signal: controller.signal });
      const transcript = await prepared.transcribe(uri, { signal: controller.signal });
      const current = this.dependencies.readDraft();
      const result = current
        ? resolveTranscriptCommit(current, current, transcript, prepared.locale)
        : null;
      if (!result || result.kind !== "commit") {
        this.setError(
          result?.kind === "empty"
            ? "No speech was detected."
            : "The transcript could not be added to the draft.",
          "retry",
        );
        return;
      }
      this.dependencies.commitDraft(result.text, result.selection);
      this.failed = null;
      this.stopRetrying();
      try {
        this.dependencies.deleteRecording(uri);
      } catch {}
      this.setState(IDLE_STATE);
    } catch (error) {
      this.setError(transcriptionErrorMessage(error), "retry");
      this.retryLater();
    }
  }

  /**
   * A transcription that failed (no network, the server down) is tried again
   * by itself, waiting longer each time, until it worked or the recording was
   * discarded. Its words go to the draft, as with Retry; nothing is sent.
   */
  private retryLater(): void {
    this.cancelAutoRetry?.();
    this.cancelAutoRetry = null;
    const setTimer = this.dependencies.setTimer;
    if (!setTimer || !this.failed) return;
    if (this.autoRetries === 0) this.retryOwner = this.dependencies.readDraft()?.ownerKey ?? null;
    const delay = AUTO_RETRY_MS[Math.min(this.autoRetries, AUTO_RETRY_MS.length - 1)]!;
    this.autoRetries++;
    // Short: it shares the composer row with Retry, Save and the send button.
    if (this.state.phase === "error" && this.state.error) {
      this.setState({ ...this.state, error: AUTO_RETRY_NOTICE });
    }
    this.cancelAutoRetry = setTimer(() => {
      this.cancelAutoRetry = null;
      // Busy with another recording, or another chat is open: the kept one
      // waits, so its words never land in the wrong draft.
      if (
        this.state.phase === "recording" ||
        this.state.phase === "transcribing" ||
        (this.dependencies.readDraft()?.ownerKey ?? null) !== this.retryOwner
      ) {
        this.retryLater();
        return;
      }
      void this.retryFailed();
    }, delay);
  }

  private stopRetrying(): void {
    this.cancelAutoRetry?.();
    this.cancelAutoRetry = null;
    this.autoRetries = 0;
    this.retryOwner = null;
  }

  /**
   * A recording found on the device from before the app closed (killed, phone
   * off): offered like a failed stop, with Retry and Save.
   */
  adoptKeptRecording(uri: string, message: string): void {
    if (this.state.phase !== "idle" || this.failed) return;
    this.failed = uri;
    this.setError(message, "retry");
  }

  /** After the user confirmed discarding the recording in progress: it is deleted. */
  cancelAndDelete(): void {
    this.keepRecordings = false;
    this.cancel();
  }

  /** After the user confirmed: the kept recording is deleted. */
  discardFailed(): void {
    const uri = this.failed;
    this.failed = null;
    this.stopRetrying();
    if (uri) {
      try {
        this.dependencies.deleteRecording(uri);
      } catch {}
    }
    if (this.state.phase === "error") this.setState(IDLE_STATE);
  }

  private async discardRecording(error: string | null): Promise<void> {
    this.invalidateOperation();
    this.setState(
      error
        ? { phase: "error", error, errorAction: "retry" }
        : { phase: "idle", error: null, errorAction: null },
    );
    try {
      await this.dependencies.recorder.stop();
    } catch {
    } finally {
      await this.releaseResources();
    }
  }

  private async releaseResources(): Promise<void> {
    this.rememberRecordingUri(this.recordingUri);
    try {
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } catch {}
    this.recordingUri = null;
    // The audio is deleted only after its words reached the draft or the chat;
    // anything else (an error, a cancel) keeps the file.
    if (!this.keepRecordings) {
      for (const uri of this.ownedRecordingUris) {
        try {
          this.dependencies.deleteRecording(uri);
        } catch {}
      }
    }
    this.ownedRecordingUris.clear();
    this.keepRecordings = true;
    await this.releaseAudioSession();
    releaseSession(this.sessionToken);
    this.sessionToken = null;
    this.capturedDraft = null;
    this.transcription = null;
    this.transcriptionAbortController = null;
  }

  private rememberRecordingUri(uri: string | null): void {
    if (uri) this.ownedRecordingUris.add(uri);
  }

  private async releaseAudioSession(): Promise<void> {
    if (!this.recordingConfigured) return;
    try {
      await this.dependencies.releaseRecording();
      this.recordingConfigured = false;
    } catch {}
  }

  private invalidateOperation(): void {
    this.operationToken += 1;
    if (this.sessionToken) this.sessionToken.abandoned = true;
    this.transcriptionAbortController?.abort();
  }

  private isCurrent(operationToken: number): boolean {
    return operationToken === this.operationToken;
  }

  private setError(error: string, errorAction: VoiceInputState["errorAction"]): void {
    this.setState({ phase: "error", error, errorAction });
  }

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}

export function resetVoiceInputGlobalsForTests(): void {
  activeSession = null;
  activeTranscriptionOperation = null;
}
