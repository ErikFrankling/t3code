import { useEffect, useRef, useState } from "react";
import { DictationState, type DictationRequest } from "@t3tools/contracts";
import { Schema } from "effect";
import {
  MicIcon,
  SquareIcon,
  XIcon,
  CheckIcon,
  LoaderCircleIcon,
  DownloadIcon,
} from "lucide-react";

import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

const decodeDictationState = Schema.decodeUnknownSync(DictationState);

async function call(body: DictationRequest): Promise<DictationState> {
  const response = await fetch("/api/dictation", {
    signal: AbortSignal.timeout(body.action === "start" ? 150000 : 30000),
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return decodeDictationState(await response.json());
}

/** A component instance belongs to exactly one composer target (React key). */
export function Dictation({
  target,
  project,
  prompt,
  onChange,
  onBusyChange,
}: {
  target: string;
  project: string | null;
  prompt: string;
  onChange: (text: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const storageKey = `t3-dictation:${target}`;
  const [state, setState] = useState<DictationState | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(0);
  const [view, setView] = useState<"draft" | "final">("draft");
  const live = useRef({ prompt, onChange });
  live.current = { prompt, onChange };
  const active = useRef(true);
  const captureRequested = useRef(false);
  const id = useRef<string | null>(null);
  const stopCapture = useRef<(() => void) | null>(null);
  const queue = useRef(Promise.resolve());
  const failed = useRef(false);
  const failedSequence = useRef(0);
  const audio = useRef<Int16Array[]>([]);
  const sequence = useRef(0);

  useEffect(() => {
    onBusyChange(starting || state?.status === "recording" || state?.status === "finalizing");
    return () => onBusyChange(false);
  }, [onBusyChange, starting, state?.status]);

  function accept(next: DictationState) {
    if (!active.current || next.id !== id.current) return;
    if (!failed.current) setError("");
    setState(next);
    if (next.status === "complete" || next.status === "error") setView("final");
  }

  useEffect(() => {
    active.current = true;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      id.current = saved;
    }
    let polling = false;
    const timer = window.setInterval(() => {
      if (!id.current || polling) return;
      polling = true;
      void call({ action: "status", id: id.current })
        .then(accept)
        .catch((cause: unknown) => {
          if (active.current) setError(String(cause));
        })
        .finally(() => {
          polling = false;
        });
    }, 800);
    return () => {
      active.current = false;
      window.clearInterval(timer);
      if (stopCapture.current) {
        stopCapture.current();
        stopCapture.current = null;
        // Finalize against the captured session, never the newly selected thread.
        const fallback = state?.status === "error" || state?.status === "cancelled";
        const recording = id.current;
        void queue.current.then(() =>
          recording && !failed.current ? call({ action: "finish", id: recording }) : undefined,
        );
      }
    };
  }, [storageKey]);

  function enqueue(samples: Int16Array, recording: string) {
    audio.current.push(samples);
    const n = sequence.current++;
    const bytes = new Uint8Array(samples.buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary);
    queue.current = queue.current.then(async () => {
      if (failed.current) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          accept(await call({ action: "append", id: recording, sequence: n, audio: encoded }));
          return;
        } catch (cause) {
          if (attempt === 2) {
            failed.current = true;
            failedSequence.current = n;
            if (active.current)
              setError(
                `Upload interrupted. Download your recording before leaving. ${String(cause)}`,
              );
          } else await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    });
  }

  async function start() {
    captureRequested.current = true;
    setOpen(true);
    setView("draft");
    setStarting(true);
    setError("");
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
      const next = await call({ action: "start", project: project ?? "" });
      if (!active.current || !captureRequested.current) {
        await call({ action: "cancel", id: next.id });
        throw new Error("Composer changed while starting the microphone.");
      }
      id.current = next.id;
      localStorage.setItem(storageKey, next.id);
      audio.current = [];
      sequence.current = 0;
      failed.current = false;
      queue.current = Promise.resolve();
      setState(next);
      const source = context.createMediaStreamSource(media);
      const processor = context.createScriptProcessor(4096, 1, 1);
      let pending: number[] = [];
      let count = 0;
      const flush = () => {
        if (pending.length) enqueue(new Int16Array(pending), next.id);
        pending = [];
      };
      processor.onaudioprocess = (event) => {
        if (count >= 16000 * 1800) return;
        const input = event.inputBuffer.getChannelData(0);
        if (active.current)
          setLevel(
            Math.min(1, Math.sqrt(input.reduce((sum, x) => sum + x * x, 0) / input.length) * 8),
          );
        for (const sample of input.subarray(0, 16000 * 1800 - count))
          pending.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
        count += input.length;
        if (pending.length >= 16000) flush();
        if (count >= 16000 * 1800) void finish();
      };
      source.connect(processor);
      processor.connect(context.destination);
      const capturedMedia = media;
      const capturedContext = context;
      stopCapture.current = () => {
        processor.onaudioprocess = null;
        processor.disconnect();
        source.disconnect();
        capturedMedia.getTracks().forEach((track) => track.stop());
        void capturedContext.close();
        flush();
      };
    } catch (cause) {
      media?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") void context.close();
      setError(String(cause));
    } finally {
      if (active.current) setStarting(false);
    }
  }

  async function finish() {
    stopCapture.current?.();
    stopCapture.current = null;
    await queue.current;
    if (!id.current || failed.current) return;
    try {
      accept(await call({ action: "finish", id: id.current }));
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function close() {
    // Closing the workspace never discards a recording. Stop capture and finish
    // in the background; the mic button reopens the saved result.
    captureRequested.current = false;
    setOpen(false);
    if (stopCapture.current) await finish();
  }

  function insert() {
    if (!state) return;
    const text = state.status === "complete" ? state.final : state.draft || state.final;
    if (!text) return;
    live.current.onChange([live.current.prompt, text].filter(Boolean).join("\n"));
    id.current = null;
    localStorage.removeItem(storageKey);
    setState(null);
    setOpen(false);
  }

  async function retryUpload() {
    stopCapture.current?.();
    stopCapture.current = null;
    await queue.current;
    const fallback = state?.status === "error" || state?.status === "cancelled";
    const recording = id.current;
    if (!recording) return;
    setError("");
    try {
      for (let n = failedSequence.current; n < audio.current.length; n++) {
        failedSequence.current = n;
        let binary = "";
        for (const byte of new Uint8Array(audio.current[n]!.buffer))
          binary += String.fromCharCode(byte);
        accept(await call({ action: "append", id: recording, sequence: n, audio: btoa(binary) }));
      }
      failed.current = false;
      accept(await call({ action: "finish", id: recording }));
    } catch (cause) {
      setError(`Retry failed; your audio is still available to download. ${String(cause)}`);
    }
  }

  function download() {
    const length = audio.current.reduce((total, chunk) => total + chunk.byteLength, 0);
    const buffer = new ArrayBuffer(44 + length);
    const view = new DataView(buffer);
    const tag = (offset: number, text: string) =>
      [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    tag(0, "RIFF");
    view.setUint32(4, length + 36, true);
    tag(8, "WAVE");
    tag(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    tag(36, "data");
    view.setUint32(40, length, true);
    let offset = 44;
    for (const chunk of audio.current) {
      new Uint8Array(buffer, offset, chunk.byteLength).set(new Uint8Array(chunk.buffer));
      offset += chunk.byteLength;
    }
    const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "dictation.wav";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const fallback = state?.status === "error" || state?.status === "cancelled";
  const recording = state?.status === "recording";
  const refining = state?.status === "finalizing";
  const seconds = Math.floor((state?.bytes ?? 0) / 32000);
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div className="px-3 py-2" data-testid="dictation">
      <button
        type="button"
        aria-label={state ? "Open dictation" : "Start dictation"}
        onClick={() => (state ? setOpen(true) : void start())}
        className="flex items-center gap-2 min-h-12 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <MicIcon className={`size-5 ${recording ? "text-red-500" : ""}`} />
        {recording ? elapsed : refining ? "Finishing…" : state ? "Your recording" : "Dictate"}
        {state?.status === "complete" && <CheckIcon className="size-4 text-emerald-500" />}
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void close();
        }}
      >
        <DialogPopup
          showCloseButton={false}
          style={{ background: "var(--background)", backdropFilter: "none" }}
          className="flex h-[min(78dvh,800px)] w-[min(94vw,960px)] max-w-[960px] flex-col gap-0 overflow-hidden p-0"
        >
          <header className="flex items-center justify-between border-b px-6 py-4">
            <DialogTitle className="text-base font-medium">Dictation</DialogTitle>
            <button
              type="button"
              aria-label="Close dictation, keep draft and audio"
              onClick={() => void close()}
              className="flex size-12 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
            >
              <XIcon className="size-5" />
            </button>
          </header>
          <nav aria-label="Transcription view" className="grid grid-cols-2 border-b md:hidden">
            <button
              type="button"
              aria-pressed={view === "draft"}
              onClick={() => setView("draft")}
              className={`min-h-12 text-sm ${view === "draft" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"}`}
            >
              Live draft
            </button>
            <button
              type="button"
              aria-pressed={view === "final"}
              onClick={() => setView("final")}
              className={`min-h-12 text-sm ${view === "final" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"}`}
            >
              {fallback ? "Saved draft" : "Refined"}
            </button>
          </nav>
          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-2">
            <section
              className={`min-h-0 overflow-auto px-6 py-5 md:block md:border-r ${view === "draft" ? "block" : "hidden"}`}
              aria-label="Live draft"
            >
              <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Live draft
              </h3>
              <p
                className="whitespace-pre-wrap text-lg leading-relaxed text-muted-foreground"
                data-testid="dictation-draft"
              >
                {state?.draft || (starting ? "Getting ready…" : "Speak naturally.")}
              </p>
            </section>
            <section
              className={`min-h-0 overflow-auto px-6 py-5 md:block ${view === "final" ? "block" : "hidden"}`}
              aria-label="Transcript"
            >
              <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {fallback
                  ? "Draft saved"
                  : state?.status === "complete"
                    ? "Ready to use"
                    : "Refined"}
              </h3>
              <p
                className="whitespace-pre-wrap text-lg leading-relaxed"
                data-testid="dictation-final"
              >
                {(fallback ? state?.draft || state?.final : state?.final) || (
                  <span className="text-muted-foreground">
                    Your finished words will appear here.
                  </span>
                )}
              </p>
            </section>
          </div>
          {(error || state?.error) && (
            <p role="alert" className="border-t px-6 py-3 text-sm text-destructive">
              {error || state?.error}
            </p>
          )}
          <footer className="flex min-h-28 items-center justify-between gap-4 border-t px-6 py-4">
            <span className="w-24 text-sm tabular-nums text-muted-foreground">{elapsed}</span>
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                aria-label={
                  !state && !starting
                    ? "Retry microphone"
                    : recording
                      ? "Stop dictation"
                      : fallback
                        ? "Insert draft"
                        : state?.status === "complete"
                          ? "Insert transcript"
                          : "Finishing dictation"
                }
                disabled={starting || refining || (fallback && !state?.draft && !state?.final)}
                onClick={() => void (recording ? finish() : !state ? start() : insert())}
                className={`flex size-16 items-center justify-center rounded-full transition-shadow disabled:opacity-60 ${recording ? "bg-red-500 text-white" : "bg-primary text-primary-foreground"}`}
                style={
                  recording
                    ? {
                        boxShadow: `0 0 0 ${4 + level * 14}px rgb(239 68 68 / ${0.08 + level * 0.15})`,
                      }
                    : undefined
                }
              >
                {starting || refining ? (
                  <LoaderCircleIcon className="size-6 motion-safe:animate-spin" />
                ) : recording ? (
                  <SquareIcon className="size-6 fill-current" />
                ) : (
                  <CheckIcon className="size-7" />
                )}
              </button>
              <span role="status" className="text-xs text-muted-foreground">
                {starting
                  ? "Getting ready"
                  : recording
                    ? "Listening"
                    : refining
                      ? "Finishing"
                      : fallback
                        ? "Use draft"
                        : state?.status === "complete"
                          ? "Use transcript"
                          : "Retry microphone"}
              </span>
            </div>
            <div className="flex w-24 justify-end gap-2">
              {(state?.status === "error" || failed.current) && (
                <button
                  type="button"
                  className="min-h-12 min-w-12 text-sm underline"
                  onClick={() => {
                    if (failed.current) void retryUpload();
                    else if (id.current)
                      void call({ action: "retry", id: id.current })
                        .then(accept)
                        .catch((cause: unknown) => setError(String(cause)));
                  }}
                >
                  Retry
                </button>
              )}
              {audio.current.length > 0 && (
                <button
                  type="button"
                  aria-label="Save audio"
                  title="Save audio"
                  onClick={download}
                  className="flex size-12 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
                >
                  <DownloadIcon className="size-5" />
                </button>
              )}
            </div>
          </footer>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
