import { useEffect, useRef, type ComponentRef } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { DictationElapsedTime } from "./ComposerDictationControl";
import { useDictationPreview } from "./dictationPreview";
import { confirmCancelDictation, splitTranscript } from "./dictationText";
import type { useVoiceInputController } from "./useVoiceInputController";

type VoiceInput = ReturnType<typeof useVoiceInputController>;

/**
 * Dictating, by default: a card right above the message box instead of the
 * whole screen, so the chat stays readable and scrollable behind it (the last
 * reply, a screenshot). The words appear as they are recognized: the finished
 * part, then what is still being worked out, lighter. Pause, Edit and Send as
 * on the full screen, which the expand button opens (and remembers).
 */
export function DictationCard(props: {
  readonly ownerKey: string | null;
  readonly voiceInput: VoiceInput;
  readonly onFullScreen: () => void;
}) {
  const voice = props.voiceInput;
  const preview = useDictationPreview(props.ownerKey);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const { height } = useWindowDimensions();
  const recording = voice.state.phase === "recording";
  const paused = voice.state.paused === true;
  const { refined, tail } = splitTranscript(preview?.final ?? "", preview?.draft ?? "");

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [refined, tail]);

  return (
    <View
      accessibilityLabel="Dictation"
      className="mx-2 mb-2 rounded-[20px] border border-border bg-card px-3.5 pt-2.5 pb-3"
    >
      <View className="flex-row items-center gap-2">
        <View
          className={
            recording && !paused
              ? "size-2 rounded-full bg-danger-foreground"
              : "size-2 rounded-full bg-foreground-tertiary"
          }
        />
        <Text className="text-sm font-t3-medium text-foreground-secondary">
          {!recording ? "Starting…" : paused ? "Paused" : "Listening"}
        </Text>
        <DictationElapsedTime seconds={voice.elapsedSeconds} className="text-sm text-foreground" />
        <View className="flex-1" />
        <IconButton
          label="Full screen"
          icon="arrow.up.left.and.arrow.down.right"
          onPress={props.onFullScreen}
        />
        <IconButton
          label="Cancel dictation"
          icon={{ ios: "xmark", android: "close" }}
          onPress={() => confirmCancelDictation(voice)}
        />
      </View>

      <ScrollView
        ref={scrollRef}
        className="mt-1.5"
        style={{ maxHeight: Math.round(height * 0.24) }}
      >
        <Text className="text-lg leading-7 text-foreground">
          {refined}
          {refined && tail ? " " : ""}
          {tail ? (
            <Text className="text-lg leading-7 text-foreground-secondary">{tail}</Text>
          ) : null}
          {!refined && !tail ? (
            <Text className="text-lg leading-7 text-foreground-secondary">
              {paused ? "Paused. Resume to keep talking." : "Listening… your words appear here."}
            </Text>
          ) : null}
        </Text>
      </ScrollView>

      <View className="mt-2.5 flex-row items-center gap-2">
        {voice.canPause ? (
          <Action
            label={paused ? "Resume" : "Pause"}
            icon={
              paused
                ? { ios: "play.fill", android: "play_arrow" }
                : { ios: "pause.fill", android: "pause" }
            }
            disabled={!recording}
            onPress={paused ? voice.resume : voice.pause}
          />
        ) : null}
        <Action
          label="Edit"
          icon={{ ios: "pencil", android: "edit" }}
          disabled={!recording}
          onPress={() => void voice.stopToDraft()}
        />
        <View className="flex-1" />
        <Action
          label="Send"
          icon={{ ios: "arrow.up", android: "arrow_upward" }}
          disabled={!recording}
          primary
          onPress={() => void voice.stop()}
        />
      </View>
    </View>
  );
}

function Action(props: {
  readonly label: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: props.disabled ? 0.4 : pressed ? 0.7 : 1 })}
      className={
        props.primary
          ? "h-11 flex-row items-center justify-center gap-1.5 rounded-full bg-primary px-5"
          : "h-11 flex-row items-center justify-center gap-1.5 rounded-full bg-subtle-strong px-4"
      }
    >
      <SymbolView
        name={props.icon}
        size={18}
        tintColorClassName={props.primary ? "accent-primary-foreground" : "accent-foreground"}
        type="monochrome"
      />
      <Text
        className={
          props.primary
            ? "text-base font-t3-bold text-primary-foreground"
            : "text-base font-t3-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function IconButton(props: {
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
      className="size-9 items-center justify-center rounded-full"
    >
      <SymbolView name={props.icon} size={18} tintColorClassName="accent-icon" type="monochrome" />
    </Pressable>
  );
}
