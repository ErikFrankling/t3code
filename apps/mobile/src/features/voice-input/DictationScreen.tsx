import { useEffect, useRef, useSyncExternalStore, type ComponentRef } from "react";
import { Modal, Pressable, ScrollView, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { voiceCall } from "../../native/voiceCall";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { DictationElapsedTime } from "./ComposerDictationControl";
import { useDictationPreview } from "./dictationPreview";
import type { useVoiceInputController } from "./useVoiceInputController";

type VoiceInput = ReturnType<typeof useVoiceInputController>;

/**
 * Dictating fills the screen: what you say, large, as it is transcribed, and
 * the controls for the recording. Pause holds it (nothing is sent or lost) and
 * Resume continues the same recording. Edit puts the words into the text box
 * instead of sending them. Send sends, and the screen closes; the chat shows
 * the message while its transcript is finished. Cancel asks before deleting.
 */
export function DictationScreen(props: {
  readonly ownerKey: string | null;
  readonly voiceInput: VoiceInput;
}) {
  const { state } = props.voiceInput;
  const inCall = useSyncExternalStore(voiceCall.subscribe, () => voiceCall.active);
  // Voice mode records its turns through the same composer, on its own screen.
  const open = !inCall && (state.phase === "preparing" || state.phase === "recording");
  return (
    <Modal
      visible={open}
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => confirmCancel(props.voiceInput)}
    >
      {open ? <DictationView {...props} /> : null}
    </Modal>
  );
}

function confirmCancel(voiceInput: VoiceInput) {
  Dialog.alert("Discard this recording?", "What you said so far will be deleted.", [
    { text: "Keep recording", style: "cancel" },
    { text: "Discard", style: "destructive", onPress: voiceInput.cancelAndDelete },
  ]);
}

function DictationView(props: {
  readonly ownerKey: string | null;
  readonly voiceInput: VoiceInput;
}) {
  const insets = useSafeAreaInsets();
  const { themeAppearance } = useAppearancePreferences();
  const voice = props.voiceInput;
  const preview = useDictationPreview(props.ownerKey);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const recording = voice.state.phase === "recording";
  const paused = voice.state.paused === true;
  const live = preview?.draft ?? "";
  const refined = preview?.final ?? "";

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [live, refined]);

  return (
    <View
      className="flex-1 bg-screen"
      style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }}
    >
      {/* The modal is its own window: without this its status bar icons keep
        the system default and vanish on the light theme. */}
      <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
      <View className="flex-row items-center gap-3 px-4">
        <RoundButton
          label="Cancel dictation"
          icon={{ ios: "xmark", android: "close" }}
          onPress={() => confirmCancel(voice)}
        />
        <Text className="flex-1 text-lg text-foreground-secondary">
          {!recording ? "Starting…" : paused ? "Paused" : "Listening"}
        </Text>
        <DictationElapsedTime seconds={voice.elapsedSeconds} className="text-lg text-foreground" />
      </View>

      <ScrollView ref={scrollRef} className="mt-6 flex-1 px-6">
        <Text className="text-3xl leading-10 text-foreground">
          {live || (paused ? "Paused. Resume to keep talking." : "Listening…")}
        </Text>
        {refined ? (
          <View className="mt-6 gap-1">
            <Text className="text-sm text-foreground-secondary">Refined</Text>
            <Text className="text-2xl leading-9 text-foreground-secondary">{refined}</Text>
          </View>
        ) : null}
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
