import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { useReadAloud } from "../threads/readAloudPlayback";
import { spokenSourceOf } from "./voiceMode";

/**
 * A line the agent said out loud (its speak tool), in the chat as its own
 * words: it stays there after it was heard, and while it is being read the
 * sentence being said is highlighted.
 */
export function SpokenMessage(props: { readonly text: string }) {
  const reading = useReadAloud();
  const speaking =
    (reading.phase === "loading" || reading.phase === "playing" || reading.phase === "paused") &&
    reading.key !== null &&
    spokenSourceOf(reading.key) === props.text &&
    reading.sentences.length > 0;

  return (
    <View accessibilityLabel="Said aloud" className="mb-3 px-2">
      <View className="mb-1 flex-row items-center gap-1.5">
        <SymbolView
          name={{ ios: "speaker.wave.2", android: "volume_up" }}
          size={13}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <Text className="text-xs text-foreground-muted">{speaking ? "Saying" : "Said aloud"}</Text>
      </View>
      <View className="rounded-2xl border border-border bg-card px-3.5 py-2.5">
        {speaking ? (
          <Text className="text-base leading-6 text-foreground">
            {reading.sentences.map((sentence, index) => (
              <Text
                // Sentences only ever append, so the index is stable.
                // oxlint-disable-next-line react/no-array-index-key
                key={index}
                className={
                  index === reading.current
                    ? "text-base leading-6 font-t3-bold text-foreground"
                    : index < reading.current
                      ? "text-base leading-6 text-foreground"
                      : "text-base leading-6 text-foreground-muted"
                }
              >
                {index > 0 ? " " : ""}
                {sentence}
              </Text>
            ))}
          </Text>
        ) : (
          <Text selectable className="text-base leading-6 text-foreground">
            {props.text}
          </Text>
        )}
      </View>
    </View>
  );
}
