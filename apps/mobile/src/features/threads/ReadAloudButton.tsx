import * as Speech from "expo-speech";
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, type ColorValue } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";

// Speech is device-wide: starting one message stops whichever was playing.
let stopCurrent: (() => void) | null = null;

/** Markdown read as prose: code blocks are announced, not spelled out. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " Code block. ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]+/g, "")
    .replace(/\n{2,}/g, ".\n")
    .trim();
}

export const ReadAloudButton = memo(function ReadAloudButton(props: {
  readonly text: string;
  readonly tintColor?: ColorValue;
  readonly iconSize?: number;
  readonly buttonSize?: number;
}) {
  const [speaking, setSpeaking] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      if (stopCurrent && stopCurrent === stopRef.current) {
        stopCurrent = null;
        void Speech.stop();
      }
    },
    [],
  );

  const start = () => {
    stopCurrent?.();
    void Speech.stop();
    const done = () => {
      if (stopCurrent === stop) stopCurrent = null;
      setSpeaking(false);
    };
    const stop = () => setSpeaking(false);
    stopCurrent = stop;
    stopRef.current = stop;
    setSpeaking(true);
    Speech.speak(speakableText(props.text), { onDone: done, onStopped: done, onError: done });
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={speaking ? "Stop reading aloud" : "Read aloud"}
      disabled={props.text.length === 0}
      hitSlop={8}
      onPress={() => {
        if (!speaking) return start();
        stopCurrent = null;
        setSpeaking(false);
        void Speech.stop();
      }}
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
          speaking
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
