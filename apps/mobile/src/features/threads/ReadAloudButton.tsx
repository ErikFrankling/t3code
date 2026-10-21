import { RegistryContext } from "@effect/atom-react";
import { READ_ALOUD_SPEEDS, ReadAloudPlayer } from "@t3tools/client-runtime/read-aloud";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { ReadAloudState, type EnvironmentId, type ReadAloudMode } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";
import { fetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import {
  memo,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentRef,
} from "react";
import { Pressable, ScrollView, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { voiceCall } from "../../native/voiceCall";
import { createReadAloudAudio } from "./readAloudAudio";
import { environmentSession } from "../../state/session";

/**
 * Read-aloud on the phone: the environment writes a short spoken summary with
 * its local models and streams the audio sentence by sentence (the server's
 * `/api/read-aloud`, shared with web and desktop); the shared player in
 * client-runtime drives it, this file only plays the clips.
 */
const decodeReadAloudState = Schema.decodeUnknownSync(ReadAloudState);

let connection: PreparedConnection | null = null;

let backgroundPlayback: boolean | null = null;
let clipNumber = 0;

const audio = createReadAloudAudio({
  createPlayer: () => createAudioPlayer(null, { updateInterval: 250 }),
  writeClip: async (base64) => {
    // Rotating files: neither the playing nor the preloaded clip is overwritten.
    const file = new File(Paths.cache, `read-aloud-${clipNumber++ % 6}.wav`);
    await file.write(base64, { encoding: "base64" });
    return file.uri;
  },
  prepare: async () => {
    // Voice mode reads replies with the screen off; otherwise reading stops when you leave.
    if (backgroundPlayback !== voiceCall.active) {
      backgroundPlayback = voiceCall.active;
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: backgroundPlayback,
      });
    }
    // Dictation turns the audio session off when it stops recording; playback needs it on.
    await setIsAudioActiveAsync(true);
  },
});

/** Frees the players (voice mode drops them while you talk; see readAloudAudio.ts). */
export function releaseReadAloudAudio() {
  audio.release();
}

export const readAloudPlayer = new ReadAloudPlayer({
  audio,
  request: async (body) => {
    const authorization = connection?.httpAuthorization ?? null;
    if (!connection || authorization?._tag === "Dpop") {
      throw new Error("Read aloud needs a direct connection to your computer.");
    }
    const response = await fetch(new URL("/api/read-aloud", connection.httpBaseUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: `Bearer ${authorization.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return decodeReadAloudState(await response.json());
  },
});

export const useReadAloud = () =>
  useSyncExternalStore(readAloudPlayer.subscribe, readAloudPlayer.getSnapshot);

/** Returns a function that points read-aloud at an environment's connection. */
export function useReadAloudEnvironment(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  return () => {
    connection = Option.getOrNull(
      registry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
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

  const nextSpeed =
    READ_ALOUD_SPEEDS.find((speed) => speed > state.speed + 0.001) ?? READ_ALOUD_SPEEDS[0];
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Playback speed"
            hitSlop={6}
            onPress={() => readAloudPlayer.setSpeed(nextSpeed)}
            className="rounded-lg px-2 py-1"
          >
            <Text className="text-sm text-foreground">{state.speed}×</Text>
          </Pressable>
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
