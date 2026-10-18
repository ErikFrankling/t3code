import { useRef, type ComponentRef } from "react";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useDictationPreview } from "./dictationPreview";

/**
 * The speech service's live draft above the composer while dictating, then the
 * final recogniser's text while it refines, as in the web composer.
 */
export function DictationLivePreview(props: { readonly visible: boolean }) {
  const preview = useDictationPreview();
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  if (!props.visible || !preview) return null;
  const refining = preview.phase === "refining";
  const text = preview.final || preview.draft;
  return (
    <View className="mx-2 mb-2 rounded-[18px] bg-subtle-strong px-3.5 py-2.5">
      <Text className="mb-1 font-t3-medium text-xs text-foreground-secondary">
        {refining ? (preview.final ? "Final" : "Refining…") : "Live draft"}
      </Text>
      <ScrollView
        ref={scrollRef}
        style={{ maxHeight: 160 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        <Text
          className={
            refining && !preview.final
              ? "text-sm text-foreground-secondary"
              : "text-sm text-foreground"
          }
        >
          {text || "Listening…"}
        </Text>
      </ScrollView>
    </View>
  );
}
