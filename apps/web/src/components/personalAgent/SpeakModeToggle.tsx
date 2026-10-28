import {
  DEFAULT_SPEAK_MODE,
  SPEAK_MODE_DESCRIPTIONS,
  SPEAK_MODE_LABELS,
  SPEAK_MODES,
  SpeakModeState,
  type EnvironmentId,
  type SpeakMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { MessagesSquareIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { environmentFetch } from "../chat/environmentFetch";

const decodeState = Schema.decodeUnknownSync(SpeakModeState);

/** How often a flip made on the phone or by key shows up here. */
const REFRESH_MS = 5_000;

const ICONS: Record<SpeakMode, ReactNode> = {
  conversation: <MessagesSquareIcon className="size-3.5" />,
  "voice-out": <Volume2Icon className="size-3.5" />,
  silent: <VolumeXIcon className="size-3.5" />,
};

/**
 * Erik's voice mode for the personal agent, shared with the phone and the
 * $mod+Alt+M key: the speak daemon keeps it, this reads it every few seconds
 * and sets it on a tap (`POST /api/speak-mode`).
 */
export function useSpeakMode(environmentId: EnvironmentId) {
  const [mode, setMode] = useState<SpeakMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A flip in flight: a refresh that started before it must not undo it.
  const pending = useRef(0);

  const call = useCallback(
    async (body: { mode?: SpeakMode }) => {
      const response = await environmentFetch(environmentId, "/api/speak-mode", body, 5_000);
      if (!response.ok) throw new Error(await response.text());
      return decodeState(await response.json()).mode;
    },
    [environmentId],
  );

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      const generation = pending.current;
      call({})
        .then((next) => {
          if (cancelled || generation !== pending.current) return;
          setMode(next);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [call]);

  const choose = useCallback(
    (next: SpeakMode) => {
      pending.current++;
      const before = mode;
      setMode(next);
      setError(null);
      call({ mode: next }).catch((cause: unknown) => {
        setMode(before);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [call, mode],
  );

  return { mode, error, choose };
}

/** Conversation / Voice out only / Silent, one tap. */
export function SpeakModeToggle({ environmentId }: { environmentId: EnvironmentId }) {
  const { mode, error, choose } = useSpeakMode(environmentId);
  const shown = mode ?? DEFAULT_SPEAK_MODE;
  return (
    <div className="mx-3 mb-2" data-testid="speak-mode">
      <div
        role="radiogroup"
        aria-label="Voice mode"
        className={cn("flex rounded-md bg-muted p-0.5", mode === null && "opacity-60")}
      >
        {SPEAK_MODES.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            title={SPEAK_MODE_DESCRIPTIONS[value]}
            disabled={mode === null}
            onClick={() => choose(value)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-xs font-medium",
              mode === value
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {ICONS[value]}
            <span className="truncate">{SPEAK_MODE_LABELS[value]}</span>
          </button>
        ))}
      </div>
      <p className="mt-1 text-2xs text-muted-foreground">
        {error ? error : SPEAK_MODE_DESCRIPTIONS[shown]}
      </p>
    </div>
  );
}
