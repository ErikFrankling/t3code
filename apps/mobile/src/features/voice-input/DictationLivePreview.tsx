import { useRef, type ComponentRef } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useDictationPreview } from "./dictationPreview";

const STATUS = {
  listening: "Listening",
  refining: "Finishing the transcript",
  // Not shown any more: sending closes the panel (the chat shows the message).
  sent: "Sent",
} as const;

function PreviewField(props: {
  readonly label: string;
  readonly text: string;
  readonly placeholder: string;
}) {
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  // Large enough to read at a glance while talking; each field takes up to
  // about a quarter of the screen and scrolls to the newest words.
  const { height } = useWindowDimensions();
  return (
    <View className="flex-1">
      <Text className="mb-1 font-t3-medium text-sm text-foreground-secondary">{props.label}</Text>
      <ScrollView
        ref={scrollRef}
        style={{ maxHeight: Math.round(height * 0.28) }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        <Text
          className={props.text ? "text-xl text-foreground" : "text-xl text-foreground-secondary"}
        >
          {props.text || props.placeholder}
        </Text>
      </ScrollView>
    </View>
  );
}

/**
 * Above the composer while dictating: the speech service's live draft and its
 * refined text side by side, as in the web composer, until the message is sent.
 */
export function DictationLivePreview(props: { readonly ownerKey: string | null }) {
  const preview = useDictationPreview(props.ownerKey);
  if (!preview) return null;
  return (
    <View className="mx-2 mb-2 gap-2 rounded-[18px] bg-subtle-strong px-3.5 py-2.5">
      <View className="gap-2">
        <PreviewField label="Live" text={preview.draft} placeholder="Listening…" />
        <PreviewField
          label="Refined"
          text={preview.final}
          placeholder={
            preview.phase === "listening" ? "Follows a few seconds behind…" : "Refining…"
          }
        />
      </View>
      <Text className="text-sm text-foreground-secondary">{STATUS[preview.phase]}</Text>
    </View>
  );
}
