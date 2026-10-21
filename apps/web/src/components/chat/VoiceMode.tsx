import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  VOICE_LOOP_CUE_KEY,
  VoiceLoop,
  type VoiceLoopPhase,
} from "@t3tools/client-runtime/voice-loop";
import {
  ArrowUpIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  ReadAloudSpeedMenu,
  readAloudPlayer,
  setReadAloudEnvironment,
  useReadAloud,
} from "./ReadAloud";

/**
 * Voice mode on web and desktop: the thread over the whole window as speech.
 * With the loop on it reads each reply aloud, says "Recording started",
 * dictates until you end the turn (the big button or Space), sends, and
 * waits for the next reply. The composer's dictation does the recording.
 */
type DictationControls = {
  readonly start: () => Promise<void>;
  readonly finish: () => Promise<void> | undefined;
  readonly recording: () => boolean;
  readonly error: () => string;
};

export type LiveDictation = {
  readonly recording: boolean;
  readonly draft: string;
  readonly final: string;
};

let dictation: DictationControls | null = null;
let live: LiveDictation = { recording: false, draft: "", final: "" };
const liveListeners = new Set<() => void>();

/** The open composer's dictation, which voice mode records and sends with. */
export function registerVoiceDictation(controls: DictationControls): () => void {
  dictation = controls;
  return () => {
    if (dictation === controls) dictation = null;
  };
}

/** What dictation hears, for the full-screen transcript. */
export function publishVoiceDictation(next: LiveDictation) {
  if (next.recording === live.recording && next.draft === live.draft && next.final === live.final) {
    return;
  }
  live = next;
  for (const listener of liveListeners) listener();
}

const useLiveDictation = () =>
  useSyncExternalStore(
    (listener) => {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    () => live,
  );

export const voiceLoop = new VoiceLoop({
  player: readAloudPlayer,
  listen: async () => {
    if (!dictation) throw new Error("Open a thread to talk to it.");
    await dictation.start();
    if (!dictation.recording())
      throw new Error(dictation.error() || "The microphone did not start.");
  },
  send: () => dictation?.finish(),
});

type VoiceModeState = { readonly open: boolean; readonly loop: boolean };
let state: VoiceModeState = { open: false, loop: false };
const listeners = new Set<() => void>();

function set(patch: Partial<VoiceModeState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

// The loop stops itself when dictation fails; the switch follows.
let loopPhase = voiceLoop.getSnapshot().phase;
voiceLoop.subscribe(() => {
  const phase = voiceLoop.getSnapshot().phase;
  if (phase === "off" && loopPhase !== "off" && state.loop) set({ loop: false });
  loopPhase = phase;
});

export const voiceMode = {
  open: () => set({ open: true }),
  close: () => {
    voiceMode.setLoop(false);
    set({ open: false });
  },
  setLoop: (on: boolean) => {
    if (on === state.loop) return;
    set({ loop: on });
    if (on) voiceLoop.start();
    else {
      voiceLoop.stop();
      // Turning the loop off mid-sentence sends what was said.
      if (dictation?.recording()) void dictation.finish();
    }
  },
};

export const useVoiceMode = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );

const useVoiceLoop = () => useSyncExternalStore(voiceLoop.subscribe, voiceLoop.getSnapshot);

const LOOP_STATUS: Record<VoiceLoopPhase, string> = {
  off: "",
  cue: "Recording started",
  listening: "Your turn",
  sending: "Sending…",
  waiting: "Thinking…",
  reading: "Reading the reply",
};

export function VoiceModeOverlay({
  environmentId,
  title,
  reply,
  working,
}: {
  environmentId: EnvironmentId;
  title: string;
  reply: { id: string; text: string } | null;
  working: boolean;
}) {
  const mode = useVoiceMode();
  const loop = useVoiceLoop();
  const reading = useReadAloud();
  const heard = useLiveDictation();
  const textRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setReadAloudEnvironment(environmentId);
  }, [environmentId]);

  const replyKey = reply?.id ?? null;
  const replyText = reply?.text ?? "";
  useEffect(() => {
    voiceLoop.update({
      reply: replyKey ? { key: replyKey, text: replyText } : null,
      working,
    });
  }, [replyKey, replyText, working]);

  const speaking =
    reading.phase === "loading" || reading.phase === "playing" || reading.phase === "paused";
  const talking = heard.recording || loop.phase === "listening" || loop.phase === "sending";
  const transcript = [heard.final, heard.draft].filter(Boolean).join("\n\n");
  // The cue is shown while it is said, not left on screen afterwards.
  const shownSentences = reading.key === VOICE_LOOP_CUE_KEY && !speaking ? [] : reading.sentences;

  useEffect(() => {
    const element = textRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [transcript, reading.current]);

  const big = (() => {
    if (mode.loop) {
      if (loop.phase === "reading" || loop.phase === "cue")
        return { label: "Skip", icon: SkipForwardIcon, action: () => voiceLoop.endTurn() };
      if (loop.phase === "listening")
        return { label: "Send", icon: ArrowUpIcon, action: () => voiceLoop.endTurn() };
      // Waiting: the reply is on its way; talking now adds to it.
      return { label: "Talk", icon: MicIcon, action: () => voiceLoop.endTurn() };
    }
    if (heard.recording)
      return { label: "Send", icon: ArrowUpIcon, action: () => void dictation?.finish() };
    if (speaking) return { label: "Stop", icon: SquareIcon, action: () => readAloudPlayer.stop() };
    return { label: "Talk", icon: MicIcon, action: () => void dictation?.start() };
  })();
  const bigAction = useRef(big.action);
  useEffect(() => {
    bigAction.current = big.action;
  });

  useEffect(() => {
    if (!mode.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") voiceMode.close();
      else if (event.key === " " && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        bigAction.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode.open]);

  if (!mode.open) return null;

  const status = mode.loop
    ? LOOP_STATUS[loop.phase]
    : heard.recording
      ? "Listening"
      : speaking
        ? "Reading"
        : working
          ? "Thinking…"
          : "Press Talk or Space";
  const error = loop.error ?? (reading.phase === "error" ? reading.error : null);
  const BigIcon = big.icon;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Voice mode"
      className="fixed inset-0 z-[60] flex flex-col bg-background/97 backdrop-blur"
    >
      <header className="flex items-center gap-3 px-5 pt-4">
        <Button aria-label="Close voice mode" size="icon" variant="ghost" onClick={voiceMode.close}>
          <XIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{title}</span>
        <label className="flex items-center gap-2 text-sm">
          Loop
          <Switch
            aria-label="Loop: read the reply, then listen again"
            checked={mode.loop}
            onCheckedChange={voiceMode.setLoop}
          />
        </label>
      </header>

      <div className="mx-auto flex w-full max-w-3xl min-h-0 flex-1 flex-col px-6">
        <h2 className="mt-8 font-semibold text-3xl">{status}</h2>
        <div
          ref={textRef}
          className="mt-4 min-h-0 flex-1 overflow-y-auto text-2xl leading-relaxed"
          aria-live="polite"
        >
          {talking ? (
            <p className="whitespace-pre-wrap">
              {transcript || (heard.recording ? "Listening…" : "")}
            </p>
          ) : (
            shownSentences.map((sentence, index) => (
              <span
                // Sentences only ever append, so the index is stable.
                // oxlint-disable-next-line react/no-array-index-key
                key={index}
                className={cn(
                  "cursor-pointer",
                  index === reading.current ? "text-foreground" : "text-muted-foreground",
                )}
                onClick={() => readAloudPlayer.seek(index)}
              >
                {sentence}{" "}
              </span>
            ))
          )}
          {error ? <p className="mt-4 text-base text-destructive">{error}</p> : null}
        </div>

        {speaking ? (
          <div className="mt-3 flex items-center justify-center gap-3">
            <Button
              aria-label="Previous sentence"
              size="icon-lg"
              variant="outline"
              onClick={() => readAloudPlayer.seek(reading.current - 1)}
            >
              <SkipBackIcon />
            </Button>
            <Button
              aria-label={reading.phase === "playing" ? "Pause" : "Play"}
              size="icon-lg"
              variant="outline"
              onClick={() => readAloudPlayer.togglePause()}
            >
              {reading.phase === "playing" ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <ReadAloudSpeedMenu speed={reading.speed} size="lg" />
          </div>
        ) : null}

        <div className="my-8 flex flex-col items-center gap-4">
          <button
            type="button"
            aria-label={big.label}
            onClick={big.action}
            className={cn(
              "flex size-40 flex-col items-center justify-center gap-1 rounded-full font-semibold text-lg shadow-lg transition-transform active:scale-95",
              talking
                ? "border-2 border-destructive/40 bg-destructive/15 text-destructive-foreground"
                : "bg-primary text-primary-foreground",
            )}
          >
            <BigIcon className="size-12" />
            {big.label}
          </button>
          {!mode.loop && reply && !speaking && !heard.recording ? (
            <Button variant="outline" onClick={() => readAloudPlayer.start(reply.id, reply.text)}>
              Read the last reply
            </Button>
          ) : null}
          <p className="text-center text-muted-foreground text-sm">
            {mode.loop
              ? "Space sends your turn, or skips the reading. Esc closes."
              : "Turn on Loop to keep talking: it reads each reply, then listens again."}
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
