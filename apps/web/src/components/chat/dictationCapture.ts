import { recordingSeconds, type DictationRecorder } from "./dictationRecorder";

// Four hours, as the speech service keeps.
const MAX_SAMPLES = 16000 * 60 * 60 * 4;

export interface DictationCapture {
  readonly id: string;
  /** Stops the microphone and stores what is buffered. The recording stays open. */
  readonly stop: () => void;
  readonly flush: () => void;
}

/**
 * Opens the microphone and feeds recording `id` (a new recording for `target`
 * when `id` is null). The recording exists on the device before the first
 * sample arrives, so nothing said is lost.
 */
export async function startDictationCapture(input: {
  readonly engine: DictationRecorder;
  readonly id: string | null;
  readonly target: string;
  readonly environmentId: string;
  readonly project: string;
  readonly threadId: string | null;
  readonly onLevel: (level: number) => void;
  readonly onLimit: () => void;
  /** Checked after the async setup; false aborts before a recording is made. */
  readonly stillWanted: () => boolean;
}): Promise<DictationCapture> {
  const { engine } = input;
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
    if (!input.stillWanted()) throw new Error("The recording was cancelled while starting.");
    const recording =
      input.id ??
      (await engine.create({
        target: input.target,
        environmentId: input.environmentId,
        project: input.project,
        threadId: input.threadId,
      }));
    if (input.id) engine.resume(input.id);
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
      const samples = event.inputBuffer.getChannelData(0);
      input.onLevel(
        Math.min(1, Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length) * 8),
      );
      for (const sample of samples.subarray(0, MAX_SAMPLES - count))
        pending.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))));
      count += samples.length;
      if (pending.length >= 16000) flush();
      if (count >= MAX_SAMPLES) input.onLimit();
    };
    source.connect(processor);
    processor.connect(context.destination);
    const capturedMedia = media;
    const capturedContext = context;
    return {
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
  } catch (cause) {
    media?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== "closed") void context.close();
    throw cause;
  }
}

export function microphoneError(cause: unknown) {
  const name = cause instanceof DOMException ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was denied. Allow it in the browser's site settings.";
  if (name === "NotFoundError" || name === "NotSupportedError" || name === "OverconstrainedError")
    return "No usable microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another application.";
  return cause instanceof Error ? cause.message : String(cause);
}
