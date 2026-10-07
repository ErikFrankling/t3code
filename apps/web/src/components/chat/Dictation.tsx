import { useEffect, useRef, useState } from "react";
import { DictationState, type DictationRequest, type EnvironmentId } from "@t3tools/contracts";
import { Schema } from "effect";
import {
  MicIcon,
  SquareIcon,
  XIcon,
  CheckIcon,
  LoaderCircleIcon,
  DownloadIcon,
} from "lucide-react";

import { randomUUID } from "../../lib/utils";
import { readPreparedConnection } from "../../state/session";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

const decodeDictationState = Schema.decodeUnknownSync(DictationState);

/**
 * The web client is same-origin with its server, but the desktop renderer is
 * served from t3code://app, so the request has to go to the environment's own
 * HTTP origin with its credential.
 */
export async function dictationFetch(
  environmentId: EnvironmentId,
  body: DictationRequest,
  timeoutMs: number,
): Promise<Response> {
  const connection = readPreparedConnection(environmentId);
  const authorization = connection?.httpAuthorization ?? null;
  if (authorization?._tag === "Dpop")
    throw new Error("Dictation is not available over a relay connection.");
  const sameOrigin =
    !connection || new URL(connection.httpBaseUrl).origin === window.location.origin;
  return fetch(sameOrigin ? "/api/dictation" : new URL("/api/dictation", connection.httpBaseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
    method: "POST",
    credentials: authorization ? "omit" : sameOrigin ? "same-origin" : "include",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: `Bearer ${authorization.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

class DictationHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call(environmentId: EnvironmentId, body: DictationRequest): Promise<DictationState> {
  const response = await dictationFetch(environmentId, body, 30000);
  if (!response.ok) throw new DictationHttpError(response.status, await response.text());
  return decodeDictationState(await response.json());
}

/** The server understood and refused; sending the same request again cannot help. */
function rejected(cause: unknown) {
  return (
    cause instanceof DictationHttpError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    cause.status !== 408 &&
    cause.status !== 429
  );
}

/** A component instance belongs to exactly one composer target (React key). */
export function Dictation({
  environmentId,
  target,
  project,
  onSend,
  onBusyChange,
}: {
  environmentId: EnvironmentId;
  target: string;
  project: string | null;
  onSend: (id: string, draft: string, uploaded: Promise<void>) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const storageKey = `t3-dictation:${target}`;
  const [state, setState] = useState<DictationState | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(0);
  const [captured, setCaptured] = useState(0);
  const [view, setView] = useState<"draft" | "final">("draft");
  const draftPanel = useRef<HTMLElement>(null);
  const finalPanel = useRef<HTMLElement>(null);
  const follow = useRef({ draft: true, final: true });
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const [kind, panel] of [
        ["draft", draftPanel.current],
        ["final", finalPanel.current],
      ] as const) {
        if (panel && follow.current[kind]) panel.scrollTop = panel.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [state?.draft, state?.final, view, open]);
  const sender = useRef(onSend);
  sender.current = onSend;
  const latestState = useRef(state);
  latestState.current = state;
  const handoff = useRef<Promise<void> | null>(null);
  const active = useRef(true);
  const captureRequested = useRef(false);
  const id = useRef<string | null>(null);
  const stopCapture = useRef<(() => void) | null>(null);
  const queue = useRef(Promise.resolve());
  const failed = useRef(false);
  const failedSequence = useRef(0);
  // The server only knows the recording once "start" lands; capture never waits for it.
  const registered = useRef(false);
  const audio = useRef<Int16Array[]>([]);
  const sequence = useRef(0);

  useEffect(() => {
    onBusyChange(starting || state?.status === "recording" || state?.status === "finalizing");
    return () => onBusyChange(false);
  }, [onBusyChange, starting, state?.status]);

  function accept(next: DictationState) {
    if (!active.current || next.id !== id.current) return;
    if (next.delivery === "sent" || next.delivery === "queued" || next.delivery === "ready") {
      localStorage.removeItem(storageKey);
      id.current = null;
      setState(null);
      setOpen(false);
      onBusyChange(false);
      return;
    }
    if (!failed.current && (next.status !== "recording" || stopCapture.current)) setError("");
    setState(next);
    if (next.status === "complete" || next.status === "error") setView("final");
  }

  useEffect(() => {
    active.current = true;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      id.current = saved;
      registered.current = true;
    }
    let polling = false;
    const timer = window.setInterval(() => {
      if (!id.current || !registered.current || polling) return;
      polling = true;
      void call(environmentId, { action: "status", id: id.current })
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
      if (stopCapture.current) void finish();
    };
  }, [storageKey]);

  /**
   * Audio is kept in memory and uploaded in order behind the microphone. An
   * unreachable or restarting server only delays the upload: it is retried
   * until it lands, and only an outright refusal stops it.
   */
  function upload(n: number, task: () => Promise<DictationState>) {
    queue.current = queue.current.then(async () => {
      if (failed.current) return;
      for (let attempt = 0; ; attempt++) {
        try {
          const next = await task();
          registered.current = true;
          accept(next);
          return;
        } catch (cause) {
          if (rejected(cause)) {
            failed.current = true;
            failedSequence.current = Math.max(0, n);
            if (active.current)
              setError(
                `Upload interrupted. Download your recording before leaving. ${String(cause)}`,
              );
            return;
          }
          if (active.current && attempt >= 2)
            setError("Reconnecting to the speech service. Keep talking; your audio is kept.");
          await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 500 * 2 ** attempt)));
        }
      }
    });
  }

  function encode(samples: Int16Array) {
    let binary = "";
    for (const byte of new Uint8Array(samples.buffer)) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function enqueue(samples: Int16Array, recording: string) {
    audio.current.push(samples);
    const n = sequence.current++;
    const encoded = encode(samples);
    upload(n, () =>
      call(environmentId, { action: "append", id: recording, sequence: n, audio: encoded }),
    );
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
      if (!active.current || !captureRequested.current)
        throw new Error("Composer changed while starting the microphone.");
      // Record now. The recording is named here so that registering it with
      // the server can run (and be retried) behind the microphone.
      const next: DictationState = {
        id: randomUUID(),
        status: "recording",
        draft: "",
        final: "",
        error: "",
        bytes: 0,
      };
      id.current = next.id;
      localStorage.setItem(storageKey, next.id);
      audio.current = [];
      sequence.current = 0;
      failed.current = false;
      registered.current = false;
      queue.current = Promise.resolve();
      setCaptured(0);
      setState(next);
      setStarting(false);
      upload(-1, () =>
        call(environmentId, { action: "start", id: next.id, project: project ?? "" }),
      );
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
        if (active.current) setCaptured(Math.min(count, 16000 * 1800));
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
    if (handoff.current) return handoff.current;
    const recording = id.current;
    if (!recording) return;
    const send = sender.current;
    const draft = latestState.current?.draft ?? "";
    stopCapture.current?.();
    stopCapture.current = null;
    if (active.current) setOpen(false);
    // Invoke the original chat callback now so it snapshots model, destination,
    // attachments and typed text before navigation. Uploads continue on unmount.
    const uploaded = queue.current.then(() => {
      if (failed.current)
        throw new Error("Upload interrupted. Your recording is retained; retry the upload.");
    });
    handoff.current = send(recording, draft, uploaded)
      .then(() => {
        localStorage.removeItem(storageKey);
        if (id.current === recording) id.current = null;
        if (active.current) {
          setState(null);
          setError("");
          onBusyChange(false);
        }
      })
      .catch((cause: unknown) => {
        console.error("dictation.handoff_failed", { recordingId: recording, error: String(cause) });
        if (active.current) {
          setError(String(cause));
          setOpen(true);
        }
      })
      .finally(() => {
        handoff.current = null;
      });
    return handoff.current;
  }

  async function close() {
    // Closing stops capture and hands delivery to the original chat.
    captureRequested.current = false;
    setOpen(false);
    if (stopCapture.current) await finish();
  }

  async function retryUpload() {
    stopCapture.current?.();
    stopCapture.current = null;
    await queue.current;
    const recording = id.current;
    if (!recording) return;
    setError("");
    failed.current = false;
    if (!registered.current)
      upload(-1, () =>
        call(environmentId, { action: "start", id: recording, project: project ?? "" }),
      );
    for (let n = failedSequence.current; n < audio.current.length; n++) {
      const encoded = encode(audio.current[n]!);
      upload(n, () =>
        call(environmentId, { action: "append", id: recording, sequence: n, audio: encoded }),
      );
    }
    await finish();
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

  const stoppedWithError = Boolean(error) && Boolean(state) && !stopCapture.current && !starting;
  const fallback = state?.status === "error" || state?.status === "cancelled" || stoppedWithError;
  const recording = state?.status === "recording" && !stoppedWithError;
  const refining = state?.status === "finalizing" && !stoppedWithError;
  const seconds = Math.floor(Math.max(captured, (state?.bytes ?? 0) / 2) / 16000);
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
              ref={draftPanel}
              onScroll={(event) => {
                const panel = event.currentTarget;
                follow.current.draft =
                  panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
              }}
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
              ref={finalPanel}
              onScroll={(event) => {
                const panel = event.currentTarget;
                follow.current.final =
                  panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
              }}
            >
              <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {fallback
                  ? "Draft saved"
                  : state?.status === "complete"
                    ? "Ready to send"
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
          <footer className="grid min-h-28 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1 border-t px-4 py-4 sm:gap-4 sm:px-6">
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
                        ? "Send draft"
                        : state?.status === "complete"
                          ? "Send transcript"
                          : "Finishing dictation"
                }
                disabled={starting || refining || (fallback && !state?.draft && !state?.final)}
                onClick={() => void (!state ? start() : finish())}
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
                        ? "Send draft"
                        : state?.status === "complete"
                          ? "Send transcript"
                          : "Retry microphone"}
              </span>
            </div>
            <div className="flex w-24 justify-self-end justify-end">
              {(fallback || failed.current) && (
                <button
                  type="button"
                  className="min-h-12 min-w-12 text-sm underline"
                  onClick={() => {
                    if (failed.current) void retryUpload();
                    else void finish();
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
