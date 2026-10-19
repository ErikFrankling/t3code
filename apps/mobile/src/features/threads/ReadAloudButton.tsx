import { RegistryContext } from "@effect/atom-react";
import {
  READ_ALOUD_SPEEDS,
  ReadAloudPlayer,
  type ReadAloudAudio,
  type ReadAloudClip,
} from "@t3tools/client-runtime/read-aloud";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { ReadAloudState, type EnvironmentId, type ReadAloudMode } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioPlayer,
} from "expo-audio";
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
import { environmentSession } from "../../state/session";

/**
 * Read-aloud on the phone: the environment writes a short spoken summary with
 * its local models and streams the audio sentence by sentence (the server's
 * `/api/read-aloud`, shared with web and desktop); the shared player in
 * client-runtime drives it, this file only plays the clips.
 */
const decodeReadAloudState = Schema.decodeUnknownSync(ReadAloudState);

let connection: PreparedConnection | null = null;

type Slot = { readonly player: AudioPlayer; id: string | null };

// Two players: one plays while the other already holds the next chunk, so
// chunks follow each other without a load gap.
let slots: [Slot, Slot] | null = null;
let active: Slot | null = null;
let rejectClip: ((error: Error) => void) | null = null;
let releaseClip: (() => void) | null = null;
let clipNumber = 0;

let backgroundPlayback: boolean | null = null;

async function slotPair(): Promise<[Slot, Slot]> {
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
  if (!slots) {
    slots = [
      { player: createAudioPlayer(null, { updateInterval: 250 }), id: null },
      { player: createAudioPlayer(null, { updateInterval: 250 }), id: null },
    ];
  }
  return slots;
}

async function load(slot: Slot, clip: ReadAloudClip) {
  if (slot.id === clip.id) return;
  // Rotating files: neither the playing nor the preloaded clip is overwritten.
  const file = new File(Paths.cache, `read-aloud-${clipNumber++ % 6}.wav`);
  await file.write(clip.audio, { encoding: "base64" });
  slot.player.replace({ uri: file.uri });
  slot.id = clip.id;
}

const audio: ReadAloudAudio = {
  play: async (clip, { rate, startFraction, next, onProgress }) => {
    rejectClip?.(new Error("replaced"));
    releaseClip?.();
    const pair = await slotPair();
    const slot =
      pair.find((candidate) => candidate.id === clip.id) ??
      pair.find((candidate) => candidate !== active) ??
      pair[0];
    // The same text gets the same clip from the server (voice mode's cue every
    // turn), and a player holding it may still sit at its end.
    const reused = slot.id === clip.id;
    await load(slot, clip);
    active = slot;
    const { player } = slot;
    if (reused && !startFraction) await player.seekTo(0);
    await new Promise<void>((resolve, reject) => {
      let seeked = !startFraction;
      const subscription = player.addListener("playbackStatusUpdate", (status) => {
        if (status.duration > 0) {
          if (!seeked) {
            seeked = true;
            void player.seekTo(status.duration * (startFraction ?? 0));
          }
          onProgress?.(status.currentTime / status.duration);
        }
        if (status.didJustFinish) {
          releaseClip?.();
          resolve();
        }
      });
      releaseClip = () => {
        subscription.remove();
        releaseClip = null;
        rejectClip = null;
      };
      rejectClip = reject;
      player.setPlaybackRate(rate, "high");
      player.play();
      const other = pair.find((candidate) => candidate !== slot);
      if (next && other) void load(other, next).catch(() => undefined);
    });
  },
  pause: () => active?.player.pause(),
  resume: () => active?.player.play(),
  stop: () => {
    active?.player.pause();
    const reject = rejectClip;
    releaseClip?.();
    reject?.(new Error("stopped"));
  },
};

/**
 * Frees the players. Each one carries a media session that answers the
 * earbud button, so voice mode drops them while you talk, and its own
 * session gets the tap. The next clip creates them again.
 */
export function releaseReadAloudAudio() {
  if (active && rejectClip) return;
  for (const slot of slots ?? []) slot.player.remove();
  slots = null;
  active = null;
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
      <View pointerEvents="box-none" className="absolute bottom-0 right-3 mb-2 flex-row gap-2">
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
    <View pointerEvents="box-none" className="absolute inset-x-0 bottom-0 mb-2 px-3">
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
