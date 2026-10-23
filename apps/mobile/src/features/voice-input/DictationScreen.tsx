import { useEffect, useRef, useState, useSyncExternalStore, type ComponentRef } from "react";
import { Modal, Pressable, ScrollView, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { voiceCall } from "../../native/voiceCall";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { DictationElapsedTime } from "./ComposerDictationControl";
import { useDictationPreview } from "./dictationPreview";
import { confirmCancelDictation, splitTranscript } from "./dictationText";
import type { useVoiceInputController } from "./useVoiceInputController";

type VoiceInput = ReturnType<typeof useVoiceInputController>;

/**
 * Dictation on the whole screen, when chosen with the card's expand button
 * (`DictationCard` is the default): what you say, large, as it is transcribed,
 * and the controls for the recording. Pause holds it (nothing is sent or lost)
 * and Resume continues the same recording. Edit puts the words into the text
 * box instead of sending them. Send sends, and the screen closes; the chat
 * shows the message while its transcript is finished. Cancel asks before
 * deleting; Back and "Make it small" go back to the card.
 */
export function DictationScreen(props: {
  readonly ownerKey: string | null;
  readonly voiceInput: VoiceInput;
  readonly fullScreen: boolean;
  readonly onSmall: () => void;
}) {
  const { state } = props.voiceInput;
  const inCall = useSyncExternalStore(voiceCall.subscribe, () => voiceCall.active);
  // Voice mode records its turns through the same composer, on its own screen.
  const open =
    props.fullScreen && !inCall && (state.phase === "preparing" || state.phase === "recording");
  // Android gives the modal its own window, which copies the app's status bar
  // style (light or dark icons) only when it opens. When the theme changes while
  // dictating, the app's style is set first and then a new window opens, so the
  // icons stay readable; opening it in the same render copied the old style.
  const { themeAppearance } = useAppearancePreferences();
  const [windowTheme, setWindowTheme] = useState(themeAppearance);
  useEffect(() => {
    if (themeAppearance === windowTheme) return;
    StatusBar.setBarStyle(themeAppearance === "dark" ? "light-content" : "dark-content");
    const frame = requestAnimationFrame(() => setWindowTheme(themeAppearance));
    return () => cancelAnimationFrame(frame);
  }, [themeAppearance, windowTheme]);
  return (
    <Modal
      key={windowTheme}
      visible={open}
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      // Back makes it small again; the recording goes on.
      onRequestClose={props.onSmall}
    >
      {open ? (
        <DictationView
          ownerKey={props.ownerKey}
          voiceInput={props.voiceInput}
          onSmall={props.onSmall}
        />
      ) : null}
    </Modal>
  );
}

function DictationView(props: {
  readonly ownerKey: string | null;
  readonly voiceInput: VoiceInput;
  readonly onSmall: () => void;
}) {
  const insets = useSafeAreaInsets();
  const voice = props.voiceInput;
  const preview = useDictationPreview(props.ownerKey);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const recording = voice.state.phase === "recording";
  const paused = voice.state.paused === true;
  const { refined, tail } = splitTranscript(preview?.final ?? "", preview?.draft ?? "");

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [refined, tail]);

  return (
    <View
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }}
    >
      <View className="flex-row items-center gap-3 px-4">
        <RoundButton
          label="Cancel dictation"
          icon={{ ios: "xmark", android: "close" }}
          onPress={() => confirmCancelDictation(voice)}
        />
        <Text className="flex-1 text-lg text-foreground-secondary">
          {!recording ? "Starting…" : paused ? "Paused" : "Listening"}
        </Text>
        <DictationElapsedTime seconds={voice.elapsedSeconds} className="text-lg text-foreground" />
        <RoundButton
          label="Make it small"
          icon="arrow.down.right.and.arrow.up.left"
          onPress={props.onSmall}
        />
      </View>

      <ScrollView ref={scrollRef} className="mt-6 flex-1 px-6">
        {/* The finished words, then what is still being worked out, lighter. */}
        <Text className="text-3xl leading-10 text-foreground">
          {refined}
          {refined && tail ? " " : ""}
          {tail ? (
            <Text className="text-3xl leading-10 text-foreground-secondary">{tail}</Text>
          ) : null}
          {!refined && !tail ? (
            <Text className="text-3xl leading-10 text-foreground-secondary">
              {paused ? "Paused. Resume to keep talking." : "Listening…"}
            </Text>
          ) : null}
        </Text>
      </ScrollView>

      <View className="mt-4 flex-row items-center justify-center gap-4 px-6">
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
          ? "h-16 min-w-28 flex-row items-center justify-center gap-2 rounded-full bg-primary px-6"
          : "h-16 min-w-24 flex-row items-center justify-center gap-2 rounded-full bg-card px-5"
      }
    >
      <SymbolView
        name={props.icon}
        size={24}
        tintColorClassName={props.primary ? "accent-primary-foreground" : "accent-foreground"}
        type="monochrome"
      />
      <Text
        className={
          props.primary
            ? "text-lg font-t3-bold text-primary-foreground"
            : "text-lg font-t3-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function RoundButton(props: {
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
      className="size-12 items-center justify-center rounded-full bg-card"
    >
      <SymbolView
        name={props.icon}
        size={22}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}
