import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { DictationState, type DictationRequest, type EnvironmentId } from "@t3tools/contracts";
import { Schema } from "effect";
import {
  ArrowUpIcon,
  DownloadIcon,
  MicIcon,
  Minimize2Icon,
  PauseIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { observeResize } from "../../lib/observeResize";
import { cn, randomUUID } from "../../lib/utils";
import { environmentFetch } from "./environmentFetch";
import {
  DictationHttpError,
  DictationRecorder,
  recordingSeconds,
  wavFile,
  type DictationEntry,
  type DictationHandoff,
} from "./dictationRecorder";
import { indexedDbDictationStorage, memoryDictationStorage } from "./dictationStorage";
import { publishVoiceDictation, registerVoiceDictation, useVoiceMode } from "./VoiceMode";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const decodeDictationState = Schema.decodeUnknownSync(DictationState);
// Four hours, as the speech service keeps.
const MAX_SAMPLES = 16000 * 60 * 60 * 4;

export function dictationFetch(
  environmentId: EnvironmentId,
  body: DictationRequest,
  timeoutMs: number,
): Promise<Response> {
  return environmentFetch(environmentId, "/api/dictation", body, timeoutMs);
}

async function call(environmentId: string, body: DictationRequest): Promise<DictationState> {
  const response = await dictationFetch(environmentId as EnvironmentId, body, 30000);
  if (!response.ok) throw new DictationHttpError(response.status, await response.text());
  return decodeDictationState(await response.json());
}

let shared: DictationRecorder | null = null;
/** One recorder per page: recordings outlive the composer that started them. */
function recorder() {
  if (!shared) {
    shared = new DictationRecorder({
      storage:
        typeof indexedDB === "undefined" ? memoryDictationStorage() : indexedDbDictationStorage(),
      request: call,
      newId: randomUUID,
    });
    void shared.load();
  }
  return shared;
}

const OPEN_STATES = new Set(["recording", "paused", "edited"]);

function duration(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function amount(seconds: number) {
  return seconds < 60 ? `${Math.max(1, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;
}

function microphoneError(cause: unknown) {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was denied. Allow it in the browser's site settings.";
  if (name === "NotFoundError" || name === "NotSupportedError" || name === "OverconstrainedError")
    return "No usable microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another application.";
  return cause instanceof Error ? cause.message : String(cause);
}

/** Refined text, then the part of the live draft it does not cover yet. */
function transcript(server: DictationEntry["record"]["server"]) {
  if (!server) return { refined: "", tail: "" };
  const final = server.final.trim();
  const draft = server.draft.trim();
  if (server.status === "complete") return { refined: final || draft, tail: "" };
  if (!final) return { refined: "", tail: draft };
  const covered = final.split(/\s+/).length;
  return { refined: final, tail: draft.split(/\s+/).slice(covered).join(" ") };
}

function uploadStatus(entry: DictationEntry) {
  if (entry.unsaved)
    return "Could not save on this device. Keep this tab open until it has uploaded.";
  if (entry.upload === "waiting")
    return "Saved on this device; uploads when the speech service is back.";
  const behind = entry.record.sizes.length - entry.record.uploaded;
  return behind > 2 ? `Saved on this device; uploading (${behind} s behind)` : "Uploaded";
}

/** A component instance belongs to exactly one composer target (React key). */
export function Dictation({
  environmentId,
  target,
  project,
  threadId,
  onSend,
  onInsert,
  onBusyChange,
}: {
  environmentId: EnvironmentId;
  target: string;
  project: string | null;
  threadId: string | null;
  onSend: DictationHandoff;
  onInsert: (text: string) => boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const engine = recorder();
  const all = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const entries = all
    .filter((entry) => entry.record.target === target && OPEN_STATES.has(entry.record.state))
    .sort((a, b) => a.record.createdAt - b.record.createdAt);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [micId, setMicId] = useState<string | null>(null);
  const [micError, setMicError] = useState("");
  const [level, setLevel] = useState(0);
  const voice = useVoiceMode();
  const selected =
    entries.find((entry) => entry.record.id === (micId ?? selectedId)) ?? entries.at(-1) ?? null;

  const handoff = useStableCallback(onSend);
  const mounted = useRef(true);
  const capture = useRef<{ id: string; stop: () => void; flush: () => void } | null>(null);
  const startError = useRef("");
  const textPanel = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => engine.registerEditor(target, onInsert), [engine, target, onInsert]);

  useEffect(() => {
    mounted.current = true;
    const flush = () => capture.current?.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", flush);
      // Leaving the chat pauses; it never ends or discards the recording.
      const running = capture.current;
      if (running) {
        running.stop();
        capture.current = null;
        engine.pause(running.id);
      }
    };
  }, [engine]);

  useEffect(() => {
    onBusyChange(starting || micId !== null);
    return () => onBusyChange(false);
  }, [onBusyChange, starting, micId]);

  const selectedRecordId = selected?.record.id;
  useEffect(() => {
    if (!open || !selectedRecordId) return;
    return engine.watch(selectedRecordId);
  }, [engine, open, selectedRecordId]);

  const shownText = transcript(selected?.record.server ?? null);
  const viewVisible = open && !voice.open;
  useEffect(() => {
    const unfinished = () =>
      engine
        .getSnapshot()
        .filter((entry) => entry.record.target === target && OPEN_STATES.has(entry.record.state))
        .length;
    let before = unfinished();
    return engine.subscribe(() => {
      const now = unfinished();
      // The last one was sent, deleted, or its transcript is in the message box.
      if (before > 0 && now === 0) setOpen(false);
      before = now;
    });
  }, [engine, target]);
  useEffect(() => {
    const panel = textPanel.current;
    const text = panel?.firstElementChild;
    if (!viewVisible || !panel || !text) return;
    // Follow the text as it grows, unless the reader scrolled up.
    return observeResize(text, () => {
      if (follow.current) panel.scrollTop = panel.scrollHeight;
    });
  }, [viewVisible]);

  useEffect(() => {
    if (viewVisible) viewRef.current?.focus();
  }, [viewVisible]);

  /** Opens the microphone and feeds `id` (a new recording when `id` is null). */
  async function openMicrophone(id: string | null): Promise<string | null> {
    if (capture.current) return capture.current.id;
    setStarting(true);
    setMicError("");
    let media: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Microphone access requires HTTPS or localhost.");
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true },
      });
      context = new AudioContext({ sampleRate: 16000 });
      if (context.sampleRate !== 16000) throw new Error("This browser cannot capture at 16 kHz.");
      await context.resume();
      if (!mounted.current) throw new Error("Composer changed while starting the microphone.");
      // The recording exists on this device before the first sample arrives.
      const recording =
        id ??
        (await engine.create({
          target,
          environmentId,
          project: project ?? "",
          threadId,
        }));
      if (id) engine.resume(id);
      const source = context.createMediaStreamSource(media);
      const processor = context.createScriptProcessor(4096, 1, 1);
      let pending: number[] = [];
      const stored = engine.getSnapshot().find((entry) => entry.record.id === recording);
      let count = stored ? recordingSeconds(stored.record) * 16000 : 0;
      const flush = () => {
        if (pending.length) void engine.append(recording, new Int16Array(pending));
        pending = [];
      };
      processor.onaudioprocess = (event) => {
        if (count >= MAX_SAMPLES) return;
        const input = event.inputBuffer.getChannelData(0);
        if (mounted.current)
          setLevel(
            Math.min(1, Math.sqrt(input.reduce((sum, x) => sum + x * x, 0) / input.length) * 8),
          );
        for (const sample of input.subarray(0, MAX_SAMPLES - count))
          pending.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
        count += input.length;
        if (pending.length >= 16000) flush();
        if (count >= MAX_SAMPLES) pauseRecording();
      };
      source.connect(processor);
      processor.connect(context.destination);
      const capturedMedia = media;
      const capturedContext = context;
      capture.current = {
        id: recording,
        flush,
        stop: () => {
          processor.onaudioprocess = null;
          processor.disconnect();
          source.disconnect();
          capturedMedia.getTracks().forEach((track) => track.stop());
          void capturedContext.close();
          flush();
        },
      };
      setMicId(recording);
      setSelectedId(recording);
      return recording;
    } catch (cause) {
      media?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") void context.close();
      const message = microphoneError(cause);
      startError.current = message;
      if (mounted.current) setMicError(message);
      return null;
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  function closeMicrophone() {
    const running = capture.current;
    if (!running) return null;
    running.stop();
    capture.current = null;
    setMicId(null);
    setLevel(0);
    return running.id;
  }

  function pauseRecording() {
    const id = closeMicrophone();
    if (id) engine.pause(id);
  }

  function resumeRecording(id: string) {
    setSelectedId(id);
    void openMicrophone(id);
  }

  function sendRecording(id: string) {
    closeMicrophone();
    const sending = engine.send(id, handoff);
    void sending.then(() => {
      const after = engine.getSnapshot().find((entry) => entry.record.id === id);
      // The chat refused it: show the recording again, nothing is lost.
      if (after?.record.notice && mounted.current) {
        setSelectedId(id);
        setOpen(true);
      }
    });
    return sending;
  }

  function editRecording(id: string) {
    closeMicrophone();
    void engine.edit(id);
  }

  async function deleteRecording(id: string) {
    if (capture.current?.id === id) closeMicrophone();
    setConfirming(false);
    await engine.remove(id);
  }

  async function download(id: string) {
    const url = URL.createObjectURL(wavFile(await engine.audio(id)));
    const link = document.createElement("a");
    link.href = url;
    link.download = "dictation.wav";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Voice mode records and sends through this composer's dictation.
  useEffect(() =>
    registerVoiceDictation({
      start: async () => {
        startError.current = "";
        await openMicrophone(null);
      },
      finish: () => (capture.current ? sendRecording(capture.current.id) : undefined),
      recording: () => capture.current !== null,
      error: () => startError.current,
    }),
  );
  const micEntry = micId ? all.find((entry) => entry.record.id === micId) : undefined;
  useEffect(() => {
    publishVoiceDictation({
      recording: micId !== null,
      draft: micEntry?.record.server?.draft ?? "",
      final: micEntry?.record.server?.final ?? "",
    });
  });
  useEffect(() => () => publishVoiceDictation({ recording: false, draft: "", final: "" }), []);

  const selectedState = selected?.record.state;
  const listening = selected !== null && selected.record.id === micId;
  const canFinish =
    selected !== null &&
    (selectedState === "recording" || selectedState === "paused") &&
    selected.record.sizes.length > 0;

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") setOpen(false);
    else if (event.key === " ") {
      if (listening) pauseRecording();
      else if (!selected) void openMicrophone(null);
      else if (selectedState === "paused") resumeRecording(selected.record.id);
    } else if (event.key === "Enter" && !event.shiftKey && canFinish && selected)
      void sendRecording(selected.record.id);
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  useEffect(() => {
    if (!viewVisible || confirming) return;
    // Space on a focused button would also click it on key-up.
    const swallow = (event: KeyboardEvent) => {
      if (event.key === " ") event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", swallow, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", swallow, true);
    };
  }, [viewVisible, confirming]);

  const micRecording = micId !== null;
  const waiting = entries.length > 0;
  const micSeconds = micEntry ? recordingSeconds(micEntry.record) : 0;
  const triggerLabel = starting
    ? "Starting the microphone"
    : micRecording
      ? `Recording ${duration(micSeconds)}; open dictation`
      : waiting
        ? `${entries.length} paused recording${entries.length === 1 ? "" : "s"}; open dictation`
        : "Dictate";

  const seconds = selected ? recordingSeconds(selected.record) : 0;
  const status = !selected
    ? starting
      ? "Starting the microphone…"
      : ""
    : [
        duration(seconds),
        selectedState === "edited"
          ? "Finishing the transcript for the message box…"
          : listening
            ? "Recording"
            : "Paused",
        uploadStatus(selected),
      ].join(" · ");
  const problem = micError || selected?.record.notice || selected?.error || "";
  const bigLabel = listening ? "Pause" : selected ? "Resume" : "Start";

  const view = viewVisible
    ? createPortal(
        <div
          ref={viewRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Dictation"
          data-testid="dictation-view"
          className="fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
        >
          <header className="flex items-center gap-2 border-b px-4 py-3 sm:px-6">
            <h2 className="font-semibold text-lg">Dictation</h2>
            <nav aria-label="Recordings" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {entries.length > 1 &&
                entries.map((entry) => (
                  <Button
                    key={entry.record.id}
                    size="sm"
                    variant={entry.record.id === selected?.record.id ? "secondary" : "ghost"}
                    aria-pressed={entry.record.id === selected?.record.id}
                    disabled={micRecording && entry.record.id !== micId}
                    onClick={() => setSelectedId(entry.record.id)}
                  >
                    {duration(recordingSeconds(entry.record))}
                    {entry.record.id === micId ? " · recording" : ""}
                  </Button>
                ))}
            </nav>
            {!micRecording && !starting && (
              <Button variant="ghost" size="sm" onClick={() => void openMicrophone(null)}>
                <PlusIcon />
                New recording
              </Button>
            )}
            {selected && selected.record.sizes.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Save audio as a file"
                onClick={() => void download(selected.record.id)}
              >
                <DownloadIcon />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Minimize; recording continues"
              onClick={() => setOpen(false)}
            >
              <Minimize2Icon />
            </Button>
          </header>

          <div
            ref={textPanel}
            className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
            onScroll={(event) => {
              const panel = event.currentTarget;
              follow.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
            }}
          >
            <p
              aria-live="polite"
              data-testid="dictation-transcript"
              className="mx-auto max-w-3xl whitespace-pre-wrap px-6 py-8 text-xl leading-relaxed md:text-2xl"
            >
              {shownText.refined || shownText.tail ? (
                <>
                  <span className="text-foreground">{shownText.refined}</span>
                  {shownText.refined && shownText.tail ? " " : ""}
                  <span className="text-muted-foreground">{shownText.tail}</span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {starting
                    ? "Getting ready…"
                    : listening
                      ? "Speak naturally. Your words appear here."
                      : selected && selected.record.sizes.length > 0
                        ? "The transcript appears here once the speech service has the audio."
                        : "Press Resume or Space to talk."}
                </span>
              )}
            </p>
          </div>

          <footer className="border-t px-4 pt-3 pb-5 sm:px-6">
            <p role="status" className="text-center text-muted-foreground text-sm tabular-nums">
              {status}
            </p>
            {problem ? (
              <p role="alert" className="mt-1 text-center text-destructive text-sm">
                {problem}
              </p>
            ) : null}
            <div className="mx-auto mt-4 grid max-w-3xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost-destructive"
                  size="lg"
                  disabled={!selected}
                  onClick={() => setConfirming(true)}
                >
                  <Trash2Icon />
                  Delete
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  disabled={!canFinish}
                  onClick={() => selected && editRecording(selected.record.id)}
                >
                  <PencilIcon />
                  Edit
                </Button>
              </div>
              <button
                type="button"
                aria-label={bigLabel}
                disabled={starting || (!listening && selectedState !== "paused" && !!selected)}
                onClick={() =>
                  listening
                    ? pauseRecording()
                    : selected
                      ? resumeRecording(selected.record.id)
                      : void openMicrophone(null)
                }
                className={cn(
                  "flex size-20 flex-col items-center justify-center gap-0.5 rounded-full font-medium text-sm shadow-lg transition-transform active:scale-95 disabled:opacity-60",
                  listening ? "bg-destructive text-white" : "bg-primary text-primary-foreground",
                )}
                style={
                  listening
                    ? {
                        boxShadow: `0 0 0 ${4 + level * 14}px color-mix(in srgb, var(--destructive) ${10 + Math.round(level * 18)}%, transparent)`,
                      }
                    : undefined
                }
              >
                {listening ? <PauseIcon className="size-7" /> : <MicIcon className="size-7" />}
                {bigLabel}
              </button>
              <div className="flex justify-end">
                <Button
                  size="xl"
                  disabled={!canFinish}
                  onClick={() => selected && void sendRecording(selected.record.id)}
                >
                  <ArrowUpIcon />
                  Send
                </Button>
              </div>
            </div>
            <p className="mt-3 hidden text-center text-muted-foreground text-xs sm:block">
              Space pauses or resumes · Enter sends · Esc minimizes
            </p>
          </footer>
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this recording?</AlertDialogTitle>
                <AlertDialogDescription>
                  {amount(seconds)} of audio will be gone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Keep it</AlertDialogClose>
                <Button
                  variant="destructive"
                  onClick={() => selected && void deleteRecording(selected.record.id)}
                >
                  Delete recording
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="dictation"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setOpen(true);
                if (!micRecording && !waiting) void openMicrophone(null);
              }}
              aria-label={triggerLabel}
            />
          }
        >
          <MicIcon
            className={micRecording ? "text-destructive" : waiting ? "text-warning" : undefined}
          />
        </TooltipTrigger>
        <TooltipPopup>{triggerLabel}</TooltipPopup>
      </Tooltip>
      {view}
    </>
  );
}
