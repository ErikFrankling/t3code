import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { resolveThreadListV2Status, threadHasUnseenCompletion } from "../threads/threadListV2";
import { useOpenAttentionCount } from "../attention/AttentionSheet";
import type { PersonalAgentEntry } from "./usePersonalAgentEntry";

type Subtitle = {
  readonly label: string;
  readonly className: string;
  readonly icon?: AppSymbolName;
  readonly iconTintClassName?: string;
};

function resolveSubtitle(thread: EnvironmentThreadShell | null): Subtitle {
  if (thread === null) {
    return { label: "Start your agent for every project", className: "text-foreground-muted" };
  }
  switch (resolveThreadListV2Status(thread)) {
    case "approval":
      return {
        label: "Needs approval",
        className: "text-warning-foreground",
        icon: "exclamationmark.shield",
        iconTintClassName: "accent-warning-foreground",
      };
    case "input":
      return {
        label: "Needs your input",
        className: "text-adaptive-indigo-600-300",
        icon: "questionmark.bubble",
        iconTintClassName: "accent-adaptive-indigo-600-300",
      };
    case "working":
      return {
        label: "Working",
        className: "text-adaptive-sky-600-400",
        icon: "circle.dashed",
        iconTintClassName: "accent-adaptive-sky-600-400",
      };
    case "failed":
    case "limited":
      return {
        label: "Stopped with an error",
        className: "text-danger-foreground",
        icon: "exclamationmark.circle",
        iconTintClassName: "accent-danger-foreground",
      };
    default:
      return threadHasUnseenCompletion(thread)
        ? {
            label: "New reply",
            className: "text-adaptive-emerald-700-300",
            icon: "checkmark.circle",
            iconTintClassName: "accent-adaptive-emerald-700-300",
          }
        : { label: "Manages your other sessions", className: "text-foreground-muted" };
  }
}

/** Home's way into the personal agent, above every other thread. */
export function PersonalAgentCard(props: {
  readonly entry: PersonalAgentEntry;
  readonly pane: "screen" | "sidebar";
}) {
  const { environmentId, thread, opening, open } = props.entry;
  const subtitle = resolveSubtitle(thread);
  const sidebarPane = props.pane === "sidebar";
  const navigation = useNavigation();
  const needsYouCount = useOpenAttentionCount(environmentId);
  return (
    <View className={cn("pb-2 pt-1", sidebarPane ? "px-1" : "px-4")}>
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel="Open the personal agent"
        accessibilityHint={subtitle.label}
        disabled={opening}
        onPress={open}
        className="flex-row items-center gap-3.5 rounded-[20px] bg-adaptive-violet-500-a12-a16 py-3 pl-3 pr-4"
        interactionClassName={sidebarPane ? "bg-thread-hover" : "bg-row-hover"}
      >
        <View className="h-11 w-11 items-center justify-center rounded-full bg-adaptive-violet-500-a12-a16">
          <SymbolView
            name="sparkles"
            size={22}
            tintColorClassName="accent-adaptive-violet-600-400"
            type="monochrome"
            weight="semibold"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            className={cn(
              "text-base font-t3-bold",
              sidebarPane ? "text-drawer-foreground" : "text-foreground",
            )}
            numberOfLines={1}
          >
            Personal agent
          </Text>
          <View className="mt-0.5 flex-row items-center gap-1">
            {subtitle.icon && subtitle.iconTintClassName ? (
              <SymbolView
                name={subtitle.icon}
                size={13}
                tintColorClassName={subtitle.iconTintClassName}
                type="monochrome"
                weight="semibold"
              />
            ) : null}
            <Text className={cn("flex-1 text-sm", subtitle.className)} numberOfLines={1}>
              {subtitle.label}
            </Text>
          </View>
        </View>
        {needsYouCount !== null ? (
          // Its own target: the card opens the chat, the pill opens the list.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              needsYouCount > 0
                ? `${needsYouCount} ${needsYouCount === 1 ? "thing needs" : "things need"} you`
                : "Needs you list"
            }
            onPress={() => navigation.navigate("Attention", { environmentId })}
            hitSlop={8}
            className={cn(
              "flex-row items-center gap-1 rounded-full px-3 py-1.5",
              needsYouCount > 0 ? "bg-primary" : "bg-adaptive-violet-500-a12-a16",
            )}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <Text
              className={cn(
                "text-sm font-t3-bold",
                needsYouCount > 0 ? "text-primary-foreground" : "text-adaptive-violet-600-400",
              )}
            >
              {needsYouCount > 0 ? `${needsYouCount} need you` : "Needs you"}
            </Text>
          </Pressable>
        ) : null}
        {opening ? (
          <AppActivityIndicator size="small" colorClassName="accent-adaptive-violet-600-400" />
        ) : (
          <SymbolView
            name="chevron.right"
            size={14}
            tintColorClassName="accent-adaptive-violet-600-400"
            type="monochrome"
            weight="semibold"
          />
        )}
      </RowPressable>
    </View>
  );
}
