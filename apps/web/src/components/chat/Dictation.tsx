import { useEffect, useRef, useState } from "react";
import { DictationState, type DictationRequest } from "@t3tools/contracts";
import { Schema } from "effect";
import { MicIcon, SquareIcon } from "lucide-react";

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
  const [manual, setManual] = useState(false);
  const live = useRef({ prompt, onChange });
  live.current = { prompt, onChange };
  const active = useRef(true);
  const id = useRef<string | null>(null);
  const base = useRef(prompt);
  const written = useRef(prompt);
  const edited = useRef(false);
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
    if (live.current.prompt !== written.current) {
      edited.current = true;
      setManual(true);
    }
    const text = next.status === "complete" ? next.final : next.draft;
    if (text && !edited.current) {
      const value = [base.current, text].filter(Boolean).join("\n");
      written.current = value;
      live.current.onChange(value);
      if (next.status === "complete") {
        id.current = null;
        localStorage.removeItem(storageKey);
      }
    }
  }

  useEffect(() => {
    active.current = true;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      id.current = saved;
      // A recovered recording must never replace a composer edited elsewhere.
      edited.current = true;
      setManual(true);
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
      if (!active.current) {
        await call({ action: "cancel", id: next.id });
        throw new Error("Composer changed while starting the microphone.");
      }
      id.current = next.id;
      localStorage.setItem(storageKey, next.id);
      base.current = live.current.prompt;
      written.current = base.current;
      edited.current = false;
      setManual(false);
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

  async function cancel() {
    stopCapture.current?.();
    stopCapture.current = null;
    await queue.current;
    if (!id.current) return;
    try {
      await call({ action: "cancel", id: id.current });
      if (!edited.current && live.current.prompt === written.current)
        live.current.onChange(base.current);
      id.current = null;
      localStorage.removeItem(storageKey);
      setState(null);
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function retryUpload() {
    stopCapture.current?.();
    stopCapture.current = null;
    await queue.current;
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

  const busy = state?.status === "recording" || state?.status === "finalizing";
  return (
    <div className="px-3 py-2 text-xs" data-testid="dictation">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label={state?.status === "recording" ? "Stop dictation" : "Start dictation"}
          disabled={starting || state?.status === "finalizing"}
          onClick={() => void (state?.status === "recording" ? finish() : start())}
        >
          {state?.status === "recording" ? (
            <SquareIcon className="size-4 text-red-500" />
          ) : (
            <MicIcon className="size-4" />
          )}
        </button>
        <span role="status">
          {starting
            ? "Starting microphone…"
            : state?.status === "recording"
              ? "Listening · draft"
              : state?.status === "finalizing"
                ? "VibeVoice is refining your recording…"
                : state?.status === "complete"
                  ? "Transcription ready"
                  : "Dictate"}
        </span>
        {state?.status === "error" && (
          <button
            type="button"
            onClick={() => {
              if (id.current)
                void call({ action: "retry", id: id.current })
                  .then(accept)
                  .catch((cause: unknown) => setError(String(cause)));
            }}
          >
            Retry saved audio
          </button>
        )}
        {busy && (
          <button type="button" onClick={() => void cancel()}>
            Cancel dictation
          </button>
        )}
        {failed.current && (
          <button type="button" onClick={() => void retryUpload()}>
            Retry audio upload
          </button>
        )}
        {audio.current.length > 0 && (!busy || failed.current) && (
          <button type="button" onClick={download}>
            Save WAV
          </button>
        )}
        {state && !busy && (
          <button
            type="button"
            onClick={() => {
              id.current = null;
              localStorage.removeItem(storageKey);
              setState(null);
              setError("");
            }}
          >
            Dismiss
          </button>
        )}
      </div>
      {(error || state?.error) && (
        <p role="alert" className="mt-1 text-destructive">
          {error || state?.error}
        </p>
      )}
      {manual && state && (
        <div className="mt-2">
          <p>{state.final || state.draft}</p>
          {state.status === "complete" && (
            <button
              type="button"
              onClick={() => {
                const value = [live.current.prompt, state.final].filter(Boolean).join("\n");
                written.current = value;
                live.current.onChange(value);
                id.current = null;
                localStorage.removeItem(storageKey);
                setState(null);
              }}
            >
              Insert transcript (keep my edits)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
