import { RegistryContext } from "@effect/atom-react";
import { READ_ALOUD_SPEEDS } from "@t3tools/client-runtime/read-aloud";
import type { EnvironmentId, ReadAloudMode } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { memo, useContext, useEffect, useRef, type ComponentRef } from "react";
import { Pressable, ScrollView, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { environmentSession } from "../../state/session";
import { readAloudPlayer, setReadAloudConnection, useReadAloud } from "./readAloudPlayback";

// The player itself lives in readAloudPlayback.ts (no UI there, so tests can load it).
export { readAloudPlayer, releaseReadAloudAudio, useReadAloud } from "./readAloudPlayback";

/** Returns a function that points read-aloud at an environment's connection. */
export function useReadAloudEnvironment(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  return () => {
    setReadAloudConnection(
      Option.getOrNull(registry.get(environmentSession.preparedConnectionValueAtom(environmentId))),
    );
  };
}

function useStartReadAloud(environmentId: EnvironmentId) {
  const selectEnvironment = useReadAloudEnvironment(environmentId);
  return (key: string, text: string, mode: ReadAloudMode = "summary") => {
    selectEnvironment();
    readAloudPlayer.start(key, text, mode);
  };
}

function IconPress(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly size?: number;
  readonly tintColor?: ColorValue;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={8}
      onPress={props.onPress}
      style={({ pressed }) => ({
        width: props.size ?? 34,
        height: props.size ?? 34,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 9,
        opacity: pressed ? 0.52 : 1,
      })}
    >
      <SymbolView
        name={props.icon}
        size={16}
        tintColor={props.tintColor}
        tintColorClassName={props.tintColor ? undefined : "accent-foreground"}
        type="monochrome"
      />
    </Pressable>
  );
}

/** Speaker button next to Copy on an assistant message. */
export const ReadAloudButton = memo(function ReadAloudButton(props: {
  readonly environmentId: EnvironmentId;
  readonly messageId: string;
  readonly text: string;
  readonly tintColor?: ColorValue;
  readonly iconSize?: number;
  readonly buttonSize?: number;
}) {
  const state = useReadAloud();
  const start = useStartReadAloud(props.environmentId);
  const active = state.key === props.messageId && state.phase !== "idle";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? "Stop reading aloud" : "Read aloud"}
      disabled={props.text.length === 0}
      hitSlop={8}
      onPress={() => (active ? readAloudPlayer.stop() : start(props.messageId, props.text))}
      style={({ pressed }) => ({
        width: props.buttonSize ?? 30,
        height: props.buttonSize ?? 30,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 9,
        opacity: pressed ? 0.52 : 1,
      })}
    >
      <SymbolView
        name={
          active
            ? { ios: "stop.fill", android: "stop_circle" }
            : { ios: "speaker.wave.2", android: "volume_up" }
        }
        size={props.iconSize ?? 13}
        tintColor={props.tintColor}
        tintColorClassName={props.tintColor ? undefined : "accent-foreground"}
        type="monochrome"
      />
    </Pressable>
  );
});

/** "1.25×", the way the speed is shown on its button and in the menu. */
export const speedLabel = (speed: number) => `${speed}×`;

/** Every playback speed in one menu; a tap picks one (the current one is checked). */
export function ReadAloudSpeedMenu(props: { readonly speed: number; readonly large?: boolean }) {
  return (
    <Menu
      title="Playback speed"
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Playback speed, ${speedLabel(props.speed)}`}
      actions={READ_ALOUD_SPEEDS.map((speed) => ({
        id: String(speed),
        title: speedLabel(speed),
        state: speed === props.speed ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => readAloudPlayer.setSpeed(Number(nativeEvent.event))}
    >
      <View
        className={
          props.large
            ? "h-14 min-w-14 flex-row items-center justify-center gap-1 rounded-full bg-card px-4"
            : "flex-row items-center gap-0.5 rounded-lg px-2 py-1"
        }
      >
        <Text className={props.large ? "text-lg text-foreground" : "text-sm text-foreground"}>
          {speedLabel(props.speed)}
        </Text>
        <SymbolView
          name={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
          size={props.large ? 18 : 14}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
      </View>
    </Menu>
  );
}

const VOICE_LABEL: Record<string, string> = { big: "Higgs", small: "Kokoro" };

/**
 * Sits on top of the composer: a pinned "Read latest" pill, and while
 * something is being read, its subtitles and controls.
 */
export function ReadAloudDock(props: {
  readonly environmentId: EnvironmentId;
  readonly latest: { readonly id: string; readonly text: string } | null;
  readonly onVoiceMode?: () => void;
  /** Raises the dock clear of the floating status pill above the composer. */
  readonly bottomOffset?: number;
}) {
  const state = useReadAloud();
  const start = useStartReadAloud(props.environmentId);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const offsets = useRef<number[]>([]);
  const current = state.current;

  useEffect(() => {
    const y = offsets.current[current];
    if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
  }, [current]);

  if (state.phase === "idle") {
    const latest = props.latest;
    return (
      <View
        pointerEvents="box-none"
        className="absolute right-3 mb-2 flex-row gap-2"
        style={{ bottom: props.bottomOffset ?? 0 }}
      >
        {props.onVoiceMode ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open voice mode"
            onPress={props.onVoiceMode}
            className="flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5"
          >
            <SymbolView
              name={{ ios: "headphones", android: "headphones" }}
              size={14}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
            <Text className="text-xs text-foreground">Voice</Text>
          </Pressable>
        ) : null}
        {latest ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Read the latest reply aloud"
            onPress={() => start(latest.id, latest.text)}
            className="flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5"
          >
            <SymbolView
              name={{ ios: "speaker.wave.2", android: "volume_up" }}
              size={14}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
            <Text className="text-xs text-foreground">Read latest</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const otherMode: ReadAloudMode = state.mode === "summary" ? "full" : "summary";

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 mb-2 px-3"
      style={{ bottom: props.bottomOffset ?? 0 }}
    >
      <View className="rounded-2xl border border-border bg-card p-3">
        <ScrollView ref={scrollRef} style={{ maxHeight: 150 }}>
          {state.sentences.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              {state.phase === "error" ? state.error : "Writing a spoken summary…"}
            </Text>
          ) : (
            state.sentences.map((sentence, index) => (
              <Text
                // Sentences only ever append, so the index is stable.
                // oxlint-disable-next-line react/no-array-index-key
                key={index}
                onLayout={(event) => {
                  offsets.current[index] = event.nativeEvent.layout.y;
                }}
                onPress={() => readAloudPlayer.seek(index)}
                className={
                  index === state.current
                    ? "rounded text-base text-foreground font-t3-medium"
                    : index < state.current
                      ? "text-base text-foreground-muted"
                      : "text-base text-foreground"
                }
              >
                {sentence}
              </Text>
            ))
          )}
        </ScrollView>
        {state.phase === "error" && state.sentences.length > 0 ? (
          <Text className="mt-1 text-xs text-foreground-muted">{state.error}</Text>
        ) : null}
        <View className="mt-2 flex-row items-center gap-1">
          <IconPress
            label="Previous sentence"
            icon={{ ios: "backward.end.fill", android: "skip_previous" }}
            onPress={() => readAloudPlayer.seek(state.current - 1)}
          />
          <IconPress
            label={state.phase === "playing" ? "Pause" : "Play"}
            icon={
              state.phase === "playing"
                ? { ios: "pause.fill", android: "pause" }
                : { ios: "play.fill", android: "play_arrow" }
            }
            onPress={() => readAloudPlayer.togglePause()}
          />
          <IconPress
            label="Next sentence"
            icon={{ ios: "forward.end.fill", android: "skip_next" }}
            onPress={() => readAloudPlayer.seek(state.current + 1)}
          />
          <ReadAloudSpeedMenu speed={state.speed} />
          <Pressable
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => readAloudPlayer.switchMode(otherMode)}
            className="rounded-lg px-2 py-1"
          >
            <Text className="text-sm text-foreground">
              {otherMode === "full" ? "Full message" : "Summary"}
            </Text>
          </Pressable>
          <Text className="ml-auto text-xs text-foreground-muted">
            {VOICE_LABEL[state.voice] ?? ""}
          </Text>
          <IconPress
            label="Stop reading"
            icon={{ ios: "xmark", android: "close" }}
            onPress={() => readAloudPlayer.stop()}
          />
        </View>
      </View>
    </View>
  );
}
