import { useRef, type ComponentRef } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useDictationPreview } from "./dictationPreview";

const STATUS = {
  listening: "Listening",
  refining: "Finishing the transcript",
  sent: "Sent. It goes to the chat when the transcript is final; you can leave.",
} as const;

function PreviewField(props: {
  readonly label: string;
  readonly text: string;
  readonly placeholder: string;
}) {
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <View className="flex-1">
      <Text className="mb-1 font-t3-medium text-xs text-foreground-secondary">{props.label}</Text>
      <ScrollView
        ref={scrollRef}
        style={{ maxHeight: 120 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        <Text
          className={props.text ? "text-sm text-foreground" : "text-sm text-foreground-secondary"}
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
      <Text className="text-xs text-foreground-secondary">{STATUS[preview.phase]}</Text>
    </View>
  );
}
