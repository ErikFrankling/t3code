import { READ_ALOUD_SPEEDS } from "@t3tools/client-runtime/read-aloud";
import { VOICE_LOOP_CUE_KEY } from "@t3tools/client-runtime/voice-loop";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, type ComponentRef } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { voiceCall } from "../../native/voiceCall";
import { readAloudPlayer, useReadAloud, useReadAloudEnvironment } from "../threads/ReadAloudButton";
import { useDictationPreview } from "../voice-input/dictationPreview";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import {
  registerVoiceModeController,
  useVoiceLoop,
  useVoiceMode,
  voiceLoop,
  voiceMode,
} from "./voiceMode";

const LOOP_STATUS = {
  off: "",
  cue: "Recording started",
  listening: "Your turn",
  sending: "Sending…",
  waiting: "Thinking…",
  reading: "Reading the reply",
} as const;

/**
 * Full screen over the thread: what you say while you talk, what is read while
 * the reply speaks, and one big button for the turn.
 */
export function VoiceModeView(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly reply: { readonly id: string; readonly text: string } | null;
  readonly working: boolean;
}) {
  const insets = useSafeAreaInsets();
  const mode = useVoiceMode();
  const loop = useVoiceLoop();
  const reading = useReadAloud();
  const voice = useGlobalVoiceInput();
  const preview = useDictationPreview(voice.ownerKey);
  const selectEnvironment = useReadAloudEnvironment(props.environmentId);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    registerVoiceModeController(voice.session.controller);
    selectEnvironment();
  });

  const replyKey = props.reply?.id ?? null;
  const replyText = props.reply?.text ?? "";
  useEffect(() => {
    voiceLoop.update({
      reply: replyKey ? { key: replyKey, text: replyText } : null,
      working: props.working,
    });
  }, [replyKey, replyText, props.working]);

  const recording = voice.state.phase === "recording";
  const speaking =
    reading.phase === "loading" || reading.phase === "playing" || reading.phase === "paused";
  const talking =
    recording ||
    voice.state.phase === "preparing" ||
    loop.phase === "listening" ||
    loop.phase === "sending";
  const transcript = preview ? [preview.final, preview.draft].filter(Boolean).join("\n\n") : "";
  // The cue is shown while it is said, not left on screen afterwards.
  const shownSentences = reading.key === VOICE_LOOP_CUE_KEY && !speaking ? [] : reading.sentences;

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [transcript, reading.current]);

  const status = mode.loop
    ? LOOP_STATUS[loop.phase]
    : recording
      ? "Listening"
      : speaking
        ? "Reading"
        : props.working
          ? "Thinking…"
          : "Tap to talk";

  const big = ((): { label: string; icon: AppSymbolName; onPress: () => void } => {
    if (mode.loop) {
      if (loop.phase === "reading" || loop.phase === "cue")
        return {
          label: "Skip",
          icon: { ios: "forward.end.fill", android: "skip_next" },
          onPress: () => voiceLoop.endTurn(),
        };
      if (loop.phase === "listening")
        return {
          label: "Send",
          icon: { ios: "arrow.up", android: "arrow_upward" },
          onPress: () => voiceLoop.endTurn(),
        };
      // Waiting: the reply is on its way; talking now adds to it.
      return {
        label: "Talk",
        icon: { ios: "mic", android: "mic" },
        onPress: () => voiceLoop.endTurn(),
      };
    }
    if (recording)
      return {
        label: "Send",
        icon: { ios: "arrow.up", android: "arrow_upward" },
        onPress: voiceMode.send,
      };
    if (speaking)
      return {
        label: "Stop",
        icon: { ios: "stop.fill", android: "stop_circle" },
        onPress: () => readAloudPlayer.stop(),
      };
    return { label: "Talk", icon: { ios: "mic", android: "mic" }, onPress: voiceMode.talk };
  })();

  const nextSpeed =
    READ_ALOUD_SPEEDS.find((speed) => speed > reading.speed + 0.001) ?? READ_ALOUD_SPEEDS[0];
  const error =
    mode.error ??
    loop.error ??
    voice.state.error ??
    (reading.phase === "error" ? reading.error : null);

  return (
    <View
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }}
    >
      <View className="flex-row items-center gap-3 px-4">
        <RoundIcon
          label="Close voice mode"
          icon={{ ios: "xmark", android: "close" }}
          onPress={voiceMode.close}
        />
        <Text className="flex-1 text-base text-foreground-muted" numberOfLines={1}>
          {props.title}
        </Text>
        <Text className="text-base text-foreground">Loop</Text>
        <ThemedSwitch
          accessibilityLabel="Loop: read the reply, then listen again"
          value={mode.loop}
          onValueChange={voiceMode.setLoop}
        />
      </View>

      <Text className="mt-6 px-6 text-3xl font-t3-bold text-foreground">{status}</Text>

      <ScrollView ref={scrollRef} className="mt-4 flex-1 px-6">
        {talking ? (
          <Text className="text-2xl leading-9 text-foreground">
            {transcript || (recording ? "Listening…" : "")}
          </Text>
        ) : (
          shownSentences.map((sentence, index) => (
            <Text
              // Sentences only ever append, so the index is stable.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              onPress={() => readAloudPlayer.seek(index)}
              className={
                index === reading.current
                  ? "text-2xl leading-9 text-foreground font-t3-semibold"
                  : "text-2xl leading-9 text-foreground-muted"
              }
            >
              {sentence}
            </Text>
          ))
        )}
        {error ? <Text className="mt-4 text-base text-foreground-muted">{error}</Text> : null}
      </ScrollView>

      {speaking ? (
        <View className="mt-2 flex-row items-center justify-center gap-6">
          <RoundIcon
            label="Previous sentence"
            icon={{ ios: "backward.end.fill", android: "skip_previous" }}
            onPress={() => readAloudPlayer.seek(reading.current - 1)}
          />
          <RoundIcon
            label={reading.phase === "playing" ? "Pause" : "Play"}
            icon={
              reading.phase === "playing"
                ? { ios: "pause.fill", android: "pause" }
                : { ios: "play.fill", android: "play_arrow" }
            }
            onPress={() => readAloudPlayer.togglePause()}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Playback speed"
            onPress={() => readAloudPlayer.setSpeed(nextSpeed)}
            className="h-14 min-w-14 items-center justify-center rounded-full bg-card px-3"
          >
            <Text className="text-lg text-foreground">{reading.speed}×</Text>
          </Pressable>
        </View>
      ) : null}

      <View className="mt-6 items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={big.label}
          onPress={big.onPress}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          className={
            talking
              ? "size-40 items-center justify-center rounded-full bg-red-600"
              : "size-40 items-center justify-center rounded-full bg-primary"
          }
        >
          <SymbolView name={big.icon} size={56} tintColor="#ffffff" type="monochrome" />
          <Text className="mt-1 text-lg font-t3-semibold text-white">{big.label}</Text>
        </Pressable>
        {!mode.loop && props.reply && !speaking && !recording ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => readAloudPlayer.start(props.reply!.id, props.reply!.text)}
            className="mt-4 rounded-full bg-card px-5 py-3"
          >
            <Text className="text-base text-foreground">Read the last reply</Text>
          </Pressable>
        ) : null}
        <Text className="mt-4 px-8 text-center text-sm text-foreground-muted">
          {mode.loop && voiceCall.available
            ? "Screen off works. A volume key or earbud tap sends your turn, or skips the reading."
            : "Turn on Loop to keep talking: it reads each reply, then listens again."}
        </Text>
      </View>
    </View>
  );
}

function RoundIcon(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={8}
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      className="size-14 items-center justify-center rounded-full bg-card"
    >
      <SymbolView
        name={props.icon}
        size={24}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}

/** Voice mode over the whole screen while it is open; Back closes it. */
export function VoiceModeHost(props: Parameters<typeof VoiceModeView>[0]) {
  const mode = useVoiceMode();
  return (
    <Modal
      visible={mode.open}
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={voiceMode.close}
    >
      {mode.open ? <VoiceModeView {...props} /> : null}
    </Modal>
  );
}
