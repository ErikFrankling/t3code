import {
  PERSONAL_AGENT_THREAD_ID,
  todoSection,
  type EnvironmentId,
  type PersonalAgentHomeState,
  type SpokenEntry,
  type TodaySummary,
} from "@t3tools/contracts";
import { PauseIcon, PlayIcon, SparklesIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { TodoList } from "./TodoList";

/** The personal agent home's live state: to-do items, what it said, today. */
export function usePersonalAgentHome(environmentId: EnvironmentId | null): {
  readonly state: PersonalAgentHomeState | null;
  readonly error: string | null;
} {
  const { data, error } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.attentionItemsLive({ environmentId, input: {} }),
  );
  return { state: data ?? null, error: error ?? null };
}

// When the user last looked at the "Said aloud" feed, so new utterances can be
// marked (in the feed and as a dot on the sidebar button).
const SEEN_KEY = "t3.personalAgent.spokenSeenAt";
const seenListeners = new Set<() => void>();
function readSeen(): string {
  try {
    return window.localStorage.getItem(SEEN_KEY) ?? "";
  } catch {
    return "";
  }
}
function subscribeSeen(listener: () => void) {
  seenListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    seenListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
export function useSpokenSeenAt(): string {
  return useSyncExternalStore(subscribeSeen, readSeen, () => "");
}
function markSpokenSeen(at: string) {
  if (at <= readSeen()) return;
  try {
    window.localStorage.setItem(SEEN_KEY, at);
  } catch {
    return;
  }
  for (const listener of seenListeners) listener();
}

/** True when the agent said something the user has not looked at yet. */
export function hasUnseenSpoken(spoken: ReadonlyArray<SpokenEntry>, seenAt: string): boolean {
  const newest = spoken[0];
  return newest !== undefined && (newest.queuedAt ?? newest.statusAt) > seenAt;
}

const formatMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest.toString().padStart(2, "0")}m` : `${rest}m`;
};

function TodayStrip({ today }: { today: TodaySummary | null }) {
  if (today === null || today.totalMinutes === 0) return null;
  const top = today.activities.slice(0, 4);
  return (
    <div className="mx-3 mb-2 rounded-lg border border-border/65 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">Today</span>
        <span className="text-2xs text-muted-foreground">
          {formatMinutes(today.totalMinutes)} tracked
        </span>
      </div>
      <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-muted">
        {top.map((entry, index) => (
          <div
            key={entry.activity}
            className={cn(
              index === 0 && "bg-info",
              index === 1 && "bg-success",
              index === 2 && "bg-warning",
              index === 3 && "bg-muted-foreground/50",
            )}
            style={{ width: `${(entry.minutes / today.totalMinutes) * 100}%` }}
          />
        ))}
      </div>
      <p className="mt-1.5 text-xs text-foreground [overflow-wrap:anywhere]">
        {top.map((entry) => `${entry.activity} ${formatMinutes(entry.minutes)}`).join(" · ")}
      </p>
      {today.current ? (
        <p className="text-2xs text-muted-foreground">Now: {today.current}</p>
      ) : null}
    </div>
  );
}

const timeOf = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms)
    ? ""
    : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(ms);
};
const dayOf = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms)
    ? ""
    : new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }).format(ms);
};

/** A chip for anything but a normal delivery, which needs no label. */
function spokenChip(entry: SpokenEntry): { readonly label: string; readonly tone: string } | null {
  const why = entry.reason ? `: ${entry.reason}` : "";
  switch (entry.status) {
    case "spoken":
      return null;
    case "speaking":
      return { label: "Speaking now", tone: "bg-info/12 text-info-foreground" };
    case "waiting":
      return { label: `Waiting${why}`, tone: "bg-warning/14 text-warning-foreground" };
    case "dropped":
      return { label: `Not said${why}`, tone: "bg-destructive/12 text-destructive-foreground" };
    case "interrupted":
      return { label: `Cut off${why}`, tone: "bg-warning/14 text-warning-foreground" };
    default:
      return { label: "Getting ready", tone: "bg-muted text-muted-foreground" };
  }
}

function ReplayPlayer({ environmentId, path }: { environmentId: EnvironmentId; path: string }) {
  const asset = useAssetUrlState(environmentId, {
    _tag: "media-file",
    threadId: PERSONAL_AGENT_THREAD_ID,
    path,
  });
  if (asset._tag === "Failure") {
    return <p className="text-2xs text-muted-foreground">The recording is gone.</p>;
  }
  if (asset._tag !== "Success") return <p className="text-2xs text-muted-foreground">Loading…</p>;
  return <audio src={asset.url} controls autoPlay className="h-8 w-full" />;
}

function SpokenItem({
  environmentId,
  entry,
  unseen,
}: {
  environmentId: EnvironmentId;
  entry: SpokenEntry;
  unseen: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const chip = spokenChip(entry);
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg px-2.5 py-2",
        unseen ? "bg-info/8" : "hover:bg-muted/60",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold tabular-nums text-foreground">
          {timeOf(entry.status === "spoken" ? entry.statusAt : (entry.queuedAt ?? entry.statusAt))}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {entry.status === "spoken" && entry.sink ? entry.sink : null}
        </span>
        {entry.audioPath ? (
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={playing ? "Hide the player" : "Replay"}
            onClick={() => setPlaying((current) => !current)}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
        ) : null}
      </div>
      {chip ? (
        <span className={cn("self-start rounded px-1.5 py-px text-2xs font-semibold", chip.tone)}>
          {chip.label}
        </span>
      ) : null}
      <p className="text-sm leading-snug text-foreground [overflow-wrap:anywhere]">{entry.text}</p>
      {playing && entry.audioPath ? (
        <ReplayPlayer environmentId={environmentId} path={entry.audioPath} />
      ) : null}
    </div>
  );
}

/** Everything the agent said out loud, newest first, grouped by day. */
function SpokenFeed({
  environmentId,
  spoken,
  seenAt,
}: {
  environmentId: EnvironmentId;
  spoken: ReadonlyArray<SpokenEntry>;
  seenAt: string;
}) {
  if (spoken.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Nothing said out loud yet. When your personal agent speaks, the text stays here.
      </p>
    );
  }
  const days = spoken.map((entry) => dayOf(entry.queuedAt ?? entry.statusAt));
  return (
    <ol className="flex flex-col gap-0.5 px-1.5 pb-3">
      {spoken.map((entry, index) => {
        const at = entry.queuedAt ?? entry.statusAt;
        const day = days[index] ?? "";
        const header = index === 0 || days[index - 1] !== day ? day : null;
        return (
          <li key={entry.id} className="contents">
            {header ? (
              <h4 className="px-2.5 pt-3 pb-1 text-2xs font-medium text-muted-foreground">
                {header}
              </h4>
            ) : null}
            <SpokenItem environmentId={environmentId} entry={entry} unseen={at > seenAt} />
          </li>
        );
      })}
    </ol>
  );
}

type SideTab = "todo" | "spoken";

/**
 * The personal agent's home: its one to-do list (Needs you on top) as the main
 * panel, the chat in the middle, and what it said out loud on the right, with
 * today's time from the Time tracker. Below the widest layout the spoken feed
 * moves into a tab beside the list.
 */
export function PersonalAgentHome({
  environmentId,
  working,
  chat,
}: {
  environmentId: EnvironmentId;
  working: boolean;
  chat: ReactNode;
}) {
  const { state, error } = usePersonalAgentHome(environmentId);
  const seenAt = useSpokenSeenAt();
  const [tab, setTab] = useState<SideTab>("todo");
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const items = state?.items ?? [];
  const spoken = state?.spoken ?? [];
  const needsYou = items.filter((item) => todoSection(item, now) === "needs_you").length;
  const newest = spoken[0];
  const unseen = hasUnseenSpoken(spoken, seenAt);

  // Opening the home counts as having seen what it said, after a moment so the
  // new ones still show as new on arrival.
  const newestAt = newest ? (newest.queuedAt ?? newest.statusAt) : null;
  useEffect(() => {
    if (newestAt === null) return;
    const timer = window.setTimeout(() => markSpokenSeen(newestAt), 4000);
    return () => window.clearTimeout(timer);
  }, [newestAt]);

  const spokenFeed = <SpokenFeed environmentId={environmentId} spoken={spoken} seenAt={seenAt} />;

  return (
    <div className="flex h-full min-h-0">
      <aside
        aria-label="Personal agent"
        className="hidden w-80 shrink-0 2xl:w-[22rem] flex-col border-r border-border/65 bg-background lg:flex"
      >
        <header className="flex items-center gap-2 px-3.5 pt-3 pb-2">
          <SparklesIcon className="size-4 text-primary" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            Personal agent
          </h2>
          <span
            className={cn("text-2xs", working ? "text-info-foreground" : "text-muted-foreground")}
          >
            {working ? "Working" : "Idle"}
          </span>
        </header>
        <TodayStrip today={state?.today ?? null} />
        <div className="mx-3 mb-1 flex rounded-md bg-muted p-0.5 2xl:hidden" role="tablist">
          {(
            [
              ["todo", needsYou > 0 ? `To-do · ${needsYou} need you` : "To-do"],
              ["spoken", unseen ? "Said aloud · new" : "Said aloud"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "flex-1 rounded px-2 py-1 text-xs font-medium",
                tab === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? <p className="px-3.5 py-2 text-xs text-muted-foreground">{error}</p> : null}
          <div className={cn(tab === "spoken" && "max-2xl:hidden")}>
            <h3 className="hidden px-3.5 pt-1 text-xs font-semibold text-foreground 2xl:block">
              To-do
              {needsYou > 0 ? (
                <span className="ml-2 font-medium text-warning-foreground">
                  {needsYou} need{needsYou === 1 ? "s" : ""} you
                </span>
              ) : null}
            </h3>
            <TodoList environmentId={environmentId} items={items} />
          </div>
          <div className={cn("2xl:hidden", tab !== "spoken" && "hidden")}>{spokenFeed}</div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">{chat}</div>
      <aside
        aria-label="Said aloud"
        className="hidden w-80 shrink-0 flex-col border-l border-border/65 bg-background 2xl:flex"
      >
        <header className="flex items-baseline justify-between px-3.5 pt-3 pb-1">
          <h2 className="text-sm font-semibold text-foreground">Said aloud</h2>
          {unseen ? <span className="text-2xs font-medium text-info-foreground">New</span> : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{spokenFeed}</div>
      </aside>
    </div>
  );
}
