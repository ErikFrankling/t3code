import {
  PERSONAL_AGENT_THREAD_ID,
  type EnvironmentId,
  type SpokenEntry,
  type TodaySummary,
} from "@t3tools/contracts";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useAssetUrl } from "../../state/assets";

const formatMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest.toString().padStart(2, "0")}m` : `${rest}m`;
};

const BAR_COLORS = [
  "bg-adaptive-sky-600-400",
  "bg-adaptive-emerald-700-300",
  "bg-warning",
  "bg-subtle-strong",
];

/** Today so far from the Time tracker. */
export function TodayStrip(props: { readonly today: TodaySummary | null }) {
  const { today } = props;
  if (today === null || today.totalMinutes === 0) return null;
  const top = today.activities.slice(0, 4);
  return (
    <View className="mt-3 gap-1.5 rounded-2xl bg-subtle px-4 py-3">
      <View className="flex-row items-baseline justify-between">
        <Text className="text-xs font-t3-bold uppercase tracking-wide text-foreground-tertiary">
          Today
        </Text>
        <Text className="text-xs text-foreground-tertiary">
          {`${formatMinutes(today.totalMinutes)} tracked`}
        </Text>
      </View>
      <View className="h-1.5 flex-row overflow-hidden rounded-full bg-subtle-strong">
        {top.map((entry, index) => (
          <View
            key={entry.activity}
            className={BAR_COLORS[index]}
            style={{ width: `${(entry.minutes / today.totalMinutes) * 100}%` }}
          />
        ))}
      </View>
      <Text className="text-sm text-foreground">
        {top.map((entry) => `${entry.activity} ${formatMinutes(entry.minutes)}`).join(" · ")}
      </Text>
      {today.current ? (
        <Text className="text-xs text-foreground-muted">{`Now: ${today.current}`}</Text>
      ) : null}
    </View>
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

function statusLabel(entry: SpokenEntry): { readonly label: string; readonly className: string } {
  switch (entry.status) {
    case "spoken":
      return {
        label: `Said ${timeOf(entry.statusAt)}${entry.sink ? ` · ${entry.sink}` : ""}`,
        className: "text-foreground-tertiary",
      };
    case "speaking":
      return { label: "Speaking now", className: "text-adaptive-sky-600-400" };
    case "waiting":
      return {
        label: `Waiting${entry.reason ? `: ${entry.reason}` : ""}`,
        className: "text-warning-foreground",
      };
    case "dropped":
      return {
        label: `Not said${entry.reason ? `: ${entry.reason}` : ""}`,
        className: "text-danger-foreground",
      };
    case "interrupted":
      return {
        label: `Cut off${entry.reason ? `: ${entry.reason}` : ""}`,
        className: "text-warning-foreground",
      };
    default:
      return { label: "Getting ready", className: "text-foreground-tertiary" };
  }
}

/** Plays the saved recording once the URL is ready; mounted only on demand. */
function ReplayPlayer(props: { readonly uri: string; readonly onDone: () => void }) {
  const player = useAudioPlayer({ uri: props.uri });
  const status = useAudioPlayerStatus(player);
  const { onDone } = props;
  useEffect(() => {
    if (status.isLoaded && !status.playing && status.currentTime === 0) player.play();
  }, [player, status.isLoaded, status.playing, status.currentTime]);
  useEffect(() => {
    if (status.didJustFinish) onDone();
  }, [onDone, status.didJustFinish]);
  return null;
}

function ReplayButton(props: { readonly environmentId: EnvironmentId; readonly path: string }) {
  const [playing, setPlaying] = useState(false);
  const uri = useAssetUrl(
    props.environmentId,
    playing ? { _tag: "media-file", threadId: PERSONAL_AGENT_THREAD_ID, path: props.path } : null,
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={playing ? "Stop" : "Replay"}
      onPress={() => setPlaying((current) => !current)}
      hitSlop={10}
      className="h-8 w-8 items-center justify-center rounded-full bg-subtle"
    >
      <SymbolView
        name={playing ? "stop.fill" : "play"}
        size={13}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
      {playing && uri !== null ? <ReplayPlayer uri={uri} onDone={() => setPlaying(false)} /> : null}
    </Pressable>
  );
}

/** Everything the agent said out loud, newest first, grouped by day. */
export function SpokenFeed(props: {
  readonly environmentId: EnvironmentId;
  readonly spoken: ReadonlyArray<SpokenEntry>;
  readonly seenAt: string;
}) {
  if (props.spoken.length === 0) {
    return (
      <Text className="pt-6 text-center text-sm text-foreground-muted">
        Nothing said out loud yet. When your personal agent speaks, the text stays here.
      </Text>
    );
  }
  const days = props.spoken.map((entry) => dayOf(entry.queuedAt ?? entry.statusAt));
  return (
    <View>
      {props.spoken.map((entry, index) => {
        const at = entry.queuedAt ?? entry.statusAt;
        const day = days[index] ?? "";
        const header = index === 0 || days[index - 1] !== day ? day : null;
        const status = statusLabel(entry);
        const unseen = at > props.seenAt;
        return (
          <View key={entry.id}>
            {header ? (
              <Text className="mt-6 mb-1 text-xs font-t3-bold uppercase tracking-wide text-foreground-tertiary">
                {header}
              </Text>
            ) : null}
            <View
              className={cn(
                "gap-1.5 border-b border-border py-3",
                unseen ? "-mx-2 rounded-xl border-b-0 bg-adaptive-sky-500-a12-a16 px-2" : null,
              )}
            >
              <View className="flex-row items-center gap-2">
                <Text className="text-sm font-t3-bold text-foreground">{timeOf(at)}</Text>
                <Text className={cn("min-w-0 flex-1 text-xs", status.className)} numberOfLines={1}>
                  {status.label}
                </Text>
                {entry.audioPath ? (
                  <ReplayButton environmentId={props.environmentId} path={entry.audioPath} />
                ) : null}
              </View>
              <Text className="text-base text-foreground">{entry.text}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}
