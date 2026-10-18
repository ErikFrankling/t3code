import { useEffect, useRef, useSyncExternalStore } from "react";
import { ReadAloudState, type EnvironmentId, type ReadAloudMode } from "@t3tools/contracts";
import {
  READ_ALOUD_SPEEDS,
  ReadAloudPlayer,
  type ReadAloudAudio,
} from "@t3tools/client-runtime/read-aloud";
import { Schema } from "effect";
import {
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SquareIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { environmentFetch } from "./environmentFetch";

const decodeReadAloudState = Schema.decodeUnknownSync(ReadAloudState);
const SPEED_KEY = "t3code:read-aloud-speed";

let environment: EnvironmentId | null = null;
let element: HTMLAudioElement | null = null;
let rejectClip: ((error: Error) => void) | null = null;
let clipListeners: AbortController | null = null;

/** One <audio> for the whole app: a new message replaces whatever was playing. */
const audio: ReadAloudAudio = {
  play: (base64, rate) =>
    new Promise<void>((resolve, reject) => {
      element ??= new Audio();
      rejectClip?.(new Error("replaced"));
      rejectClip = reject;
      clipListeners?.abort();
      clipListeners = new AbortController();
      const { signal } = clipListeners;
      element.addEventListener("ended", () => resolve(), { signal });
      element.addEventListener("error", () => reject(new Error("The audio could not be played.")), {
        signal,
      });
      element.src = `data:audio/mpeg;base64,${base64}`;
      element.preservesPitch = true;
      element.defaultPlaybackRate = rate;
      element.playbackRate = rate;
      element.play().catch(reject);
    }),
  pause: () => element?.pause(),
  resume: () => void element?.play(),
  stop: () => {
    element?.pause();
    rejectClip?.(new Error("stopped"));
    rejectClip = null;
  },
};

const storedSpeed = Number(globalThis.localStorage?.getItem(SPEED_KEY));

export const readAloudPlayer = new ReadAloudPlayer({
  audio,
  speed: storedSpeed > 0 ? storedSpeed : 1,
  onSpeedChange: (speed) => globalThis.localStorage?.setItem(SPEED_KEY, String(speed)),
  request: async (body) => {
    if (!environment) throw new Error("No environment to read with.");
    const response = await environmentFetch(environment, "/api/read-aloud", body, 30_000);
    if (!response.ok) throw new Error(await response.text());
    return decodeReadAloudState(await response.json());
  },
});

export function startReadAloud(
  environmentId: EnvironmentId,
  key: string,
  text: string,
  mode: ReadAloudMode = "summary",
) {
  environment = environmentId;
  readAloudPlayer.start(key, text, mode);
}

export const useReadAloud = () =>
  useSyncExternalStore(readAloudPlayer.subscribe, readAloudPlayer.getSnapshot);

/** Speaker button in an assistant message's action row. */
export function ReadAloudButton({
  environmentId,
  messageId,
  text,
}: {
  environmentId: EnvironmentId;
  messageId: string;
  text: string;
}) {
  const state = useReadAloud();
  const active = state.key === messageId && state.phase !== "idle";
  const label = active ? "Stop reading" : "Read aloud";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() =>
              active ? readAloudPlayer.stop() : startReadAloud(environmentId, messageId, text)
            }
          />
        }
      >
        {active ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
}

const VOICE_LABEL: Record<string, string> = { big: "Higgs", small: "Kokoro" };

/**
 * Above the composer: a pinned "Read latest" button, and while something is
 * being read, the subtitles of what is spoken with its controls.
 */
export function ReadAloudDock({
  environmentId,
  latest,
}: {
  environmentId: EnvironmentId;
  latest: { id: string; text: string } | null;
}) {
  const state = useReadAloud();
  const currentRef = useRef<HTMLSpanElement | null>(null);
  const active = state.phase !== "idle";

  const current = state.current;
  useEffect(() => {
    if (current >= 0) currentRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [current]);

  const read = (mode: ReadAloudMode) => {
    if (!latest) return;
    startReadAloud(environmentId, latest.id, latest.text, mode);
  };

  if (!active) {
    if (!latest) return null;
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-full mb-2 flex justify-end px-2">
        <Button
          aria-label="Read the latest reply aloud"
          className="pointer-events-auto"
          size="xs"
          variant="glass"
          onClick={() => read("summary")}
        >
          <Volume2Icon className="size-3.5" />
          Read latest
        </Button>
      </div>
    );
  }

  const nextSpeed =
    READ_ALOUD_SPEEDS.find((speed) => speed > state.speed + 0.001) ?? READ_ALOUD_SPEEDS[0];
  const restartMode: ReadAloudMode = state.mode === "summary" ? "full" : "summary";

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full mb-2 px-2">
      <div
        role="region"
        aria-label="Read aloud"
        className="pointer-events-auto rounded-xl border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur"
      >
        <div className="max-h-36 overflow-y-auto text-sm leading-relaxed" aria-live="polite">
          {state.sentences.length === 0 ? (
            <span className="text-muted-foreground">
              {state.phase === "error" ? state.error : "Writing a spoken summary…"}
            </span>
          ) : (
            state.sentences.map((sentence, index) => (
              <span
                // Sentences only ever append, so the index is stable.
                // oxlint-disable-next-line react/no-array-index-key
                key={index}
                ref={index === state.current ? currentRef : undefined}
                className={cn(
                  "cursor-pointer rounded-sm",
                  index === state.current
                    ? "bg-primary/15 text-foreground"
                    : index < state.current
                      ? "text-muted-foreground"
                      : "text-foreground/80",
                )}
                onClick={() => readAloudPlayer.seek(index)}
              >
                {sentence}{" "}
              </span>
            ))
          )}
        </div>
        {state.phase === "error" && state.sentences.length > 0 ? (
          <p className="mt-1 text-destructive text-xs">{state.error}</p>
        ) : null}
        <div className="mt-2 flex items-center gap-1">
          <Button
            aria-label="Previous sentence"
            size="icon-xs"
            variant="ghost"
            onClick={() => readAloudPlayer.seek(state.current - 1)}
          >
            <SkipBackIcon />
          </Button>
          <Button
            aria-label={state.phase === "playing" ? "Pause" : "Play"}
            size="icon-xs"
            variant="ghost"
            onClick={() => readAloudPlayer.togglePause()}
          >
            {state.phase === "loading" ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : state.phase === "playing" ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </Button>
          <Button
            aria-label="Next sentence"
            size="icon-xs"
            variant="ghost"
            onClick={() => readAloudPlayer.seek(state.current + 1)}
          >
            <SkipForwardIcon />
          </Button>
          <Button
            aria-label="Playback speed"
            size="xs"
            variant="ghost"
            onClick={() => readAloudPlayer.setSpeed(nextSpeed)}
          >
            {state.speed}×
          </Button>
          <Button size="xs" variant="ghost" onClick={() => readAloudPlayer.switchMode(restartMode)}>
            {restartMode === "full" ? "Read full message" : "Read summary"}
          </Button>
          <span className="ml-auto text-muted-foreground text-xs">
            {VOICE_LABEL[state.voice] ?? ""}
          </span>
          <Button
            aria-label="Stop reading"
            size="icon-xs"
            variant="ghost"
            onClick={() => readAloudPlayer.stop()}
          >
            <XIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}
