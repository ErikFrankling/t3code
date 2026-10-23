import { VOICE_LOOP_CUE_KEY } from "@t3tools/client-runtime/voice-loop";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, type ComponentRef } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { voiceCall } from "../../native/voiceCall";
import { useReadAloud, useReadAloudEnvironment } from "../threads/ReadAloudButton";
import { useDictationPreview } from "../voice-input/dictationPreview";
import { splitTranscript } from "../voice-input/dictationText";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import {
  registerVoiceModeController,
  useVoiceMode,
  useVoiceSession,
  voiceMode,
  voiceModeThreadChanged,
} from "./voiceMode";

const STATUS = {
  off: "",
  idle: "Voice mode on",
  speaking: "Speaking",
  cue: "Your turn",
  listening: "Your turn",
  sending: "Sending…",
} as const;

/**
 * Voice mode, in the flow right above the composer like the dictation card:
 * the chat stays visible, scrollable and tappable behind it, so the agent's
 * last message, a screenshot or anything earlier can be looked at without
 * leaving voice mode. What the agent says stays in the chat as its own
 * message; this card shows what is being said now, or Erik's own words as
 * they are recognized. Only Stop ends it.
 */
export function VoiceModeCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly reply: { readonly id: string; readonly text: string } | null;
  readonly working: boolean;
}) {
  const mode = useVoiceMode();
  const session = useVoiceSession();
  const reading = useReadAloud();
  const voice = useGlobalVoiceInput();
  const preview = useDictationPreview(voice.ownerKey);
  const selectEnvironment = useReadAloudEnvironment(props.environmentId);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const { height } = useWindowDimensions();

  useEffect(() => {
    registerVoiceModeController(voice.session.controller);
    selectEnvironment();
  });

  const replyKey = props.reply?.id ?? null;
  const replyText = props.reply?.text ?? "";
  useEffect(() => {
    voiceModeThreadChanged(
      props.threadId,
      replyKey ? { id: replyKey, text: replyText } : null,
      props.working,
    );
  }, [props.threadId, replyKey, replyText, props.working, mode.on]);

  const talking = session.phase === "cue" || session.phase === "listening";
  const { refined, tail } = splitTranscript(preview?.final ?? "", preview?.draft ?? "");
  const speakingNow =
    session.phase === "speaking" && reading.key !== null && reading.key !== VOICE_LOOP_CUE_KEY;
  const sentence = speakingNow ? (reading.sentences[reading.current] ?? "") : "";

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [refined, tail]);

  if (!mode.on || mode.threadId !== props.threadId) return null;

  const big = ((): { label: string; icon: AppSymbolName } => {
    if (session.phase === "listening" || session.phase === "cue")
      return { label: "Send", icon: { ios: "arrow.up", android: "arrow_upward" } };
    if (session.phase === "speaking")
      return { label: "Answer", icon: { ios: "mic", android: "mic" } };
    return { label: "Talk", icon: { ios: "mic", android: "mic" } };
  })();

  const error = mode.error ?? session.error ?? voice.state.error;
  const hint = talking
    ? null
    : session.phase === "speaking"
      ? "The full message is in the chat."
      : session.waiting > 0
        ? `${session.waiting} more to say`
        : voiceCall.available
          ? "Your agent may speak to you now. Volume down or an earbud tap to talk."
          : "Your agent may speak to you now.";

  return (
    <View
      accessibilityLabel="Voice mode"
      className="mx-2 mb-2 rounded-[20px] border border-border bg-card px-3.5 pt-2.5 pb-3"
    >
      <View className="flex-row items-center gap-2">
        <View
          className={
            talking
              ? "size-2 rounded-full bg-danger-foreground"
              : session.phase === "speaking"
                ? "size-2 rounded-full bg-primary"
                : "size-2 rounded-full bg-foreground-tertiary"
          }
        />
        <SymbolView
          name={{ ios: "headphones", android: "headphones" }}
          size={14}
          tintColorClassName="accent-foreground-secondary"
          type="monochrome"
        />
        <Text className="text-sm font-t3-medium text-foreground-secondary">
          {STATUS[session.phase]}
        </Text>
        <View className="flex-1" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop voice mode"
          hitSlop={8}
          onPress={voiceMode.stop}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          className="flex-row items-center gap-1 rounded-full border border-border px-2.5 py-1"
        >
          <SymbolView
            name={{ ios: "xmark", android: "close" }}
            size={12}
            tintColorClassName="accent-foreground"
            type="monochrome"
          />
          <Text className="text-sm text-foreground">Stop</Text>
        </Pressable>
      </View>

      {talking ? (
        <ScrollView
          ref={scrollRef}
          className="mt-1.5"
          style={{ maxHeight: Math.round(height * 0.2) }}
        >
          <Text className="text-lg leading-7 text-foreground">
            {refined}
            {refined && tail ? " " : ""}
            {tail ? (
              <Text className="text-lg leading-7 text-foreground-secondary">{tail}</Text>
            ) : null}
            {!refined && !tail ? (
              <Text className="text-lg leading-7 text-foreground-secondary">
                Listening… your words appear here.
              </Text>
            ) : null}
          </Text>
        </ScrollView>
      ) : sentence ? (
        <Text numberOfLines={3} className="mt-1.5 text-lg leading-7 text-foreground">
          {sentence}
        </Text>
      ) : null}

      {error ? <Text className="mt-1.5 text-sm text-foreground-muted">{error}</Text> : null}

      <View className="mt-2.5 flex-row items-center gap-2">
        {hint ? <Text className="flex-1 text-sm text-foreground-muted">{hint}</Text> : null}
        {!hint ? <View className="flex-1" /> : null}
        {talking ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard what you said"
            onPress={voiceMode.discard}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            className="h-11 flex-row items-center justify-center gap-1.5 rounded-full bg-subtle-strong px-4"
          >
            <SymbolView
              name={{ ios: "xmark", android: "close" }}
              size={18}
              tintColorClassName="accent-foreground"
              type="monochrome"
            />
            <Text className="text-base font-t3-medium text-foreground">Discard</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={big.label}
          disabled={session.phase === "sending"}
          onPress={voiceMode.press}
          style={({ pressed }) => ({
            opacity: session.phase === "sending" ? 0.4 : pressed ? 0.7 : 1,
          })}
          className={
            talking
              ? "h-11 flex-row items-center justify-center gap-1.5 rounded-full bg-primary px-5"
              : "h-11 flex-row items-center justify-center gap-1.5 rounded-full bg-subtle-strong px-4"
          }
        >
          <SymbolView
            name={big.icon}
            size={18}
            tintColorClassName={talking ? "accent-primary-foreground" : "accent-foreground"}
            type="monochrome"
          />
          <Text
            className={
              talking
                ? "text-base font-t3-bold text-primary-foreground"
                : "text-base font-t3-medium text-foreground"
            }
          >
            {big.label}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
