import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  PERSONAL_AGENT_THREAD_ID,
  todoAge,
  todoChip,
  todoSection,
  type AttentionItem,
  type EnvironmentId,
  type ThreadId,
  type TodoChipTone,
  type TodoSection,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { PullRequestMarkdown } from "../pull-requests/PullRequestMarkdown";
import { SpokenFeed, TodayStrip } from "./PersonalAgentHomeParts";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

export type AttentionTarget = { readonly environmentId: EnvironmentId };

// When the user last opened the home, so new spoken entries can be marked.
let spokenSeenAt = "";

const TONE_CLASS: Record<TodoChipTone, { readonly box: string; readonly text: string }> = {
  attention: { box: "bg-warning", text: "text-warning-foreground" },
  active: { box: "bg-subtle-strong", text: "text-primary-text" },
  waiting: { box: "bg-subtle", text: "text-foreground-muted" },
  muted: { box: "bg-subtle", text: "text-foreground-muted" },
  done: { box: "bg-subtle", text: "text-foreground-muted" },
};

const SECTION_TITLE: Record<TodoSection, string> = {
  needs_you: "Needs you",
  moving: "Moving",
  waiting: "Waiting",
  standing: "Standing rules",
  done: "Done this week",
};

/** Items that wait on the user, for the card's count. Null while the server lacks the list. */
export function useOpenAttentionCount(environmentId: EnvironmentId | null): number | null {
  const config = useEnvironmentServerConfig(environmentId);
  const supported =
    environmentId !== null && config?.environment.capabilities.attentionItems === true;
  const { data } = useEnvironmentQuery(
    supported && environmentId !== null
      ? serverEnvironment.attentionItemsLive({ environmentId, input: {} })
      : null,
  );
  if (!supported) return null;
  const now = Date.now();
  return data?.items.filter((item) => todoSection(item, now) === "needs_you").length ?? 0;
}

function ThreadChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const title = shell?.title?.trim() || props.threadId;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open thread ${title}`}
      onPress={() => props.onOpen(props.threadId)}
      className="max-w-full flex-row items-center gap-1 rounded-full bg-subtle px-2.5 py-1"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name="bubble.left.and.bubble.right"
        size={12}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      <Text className="shrink text-xs font-t3-medium text-foreground-secondary" numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

function Chip(props: { readonly tone: TodoChipTone; readonly label: string }) {
  const tone = TONE_CLASS[props.tone];
  return (
    <View className={cn("rounded px-1.5 py-0.5", tone.box)}>
      <Text className={cn("text-[10px] font-t3-bold uppercase tracking-wide", tone.text)}>
        {props.label}
      </Text>
    </View>
  );
}

function TodoRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: AttentionItem;
  readonly now: number;
  readonly canTick: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  const [open, setOpen] = useState(false);
  const section = todoSection(item, props.now);
  const chip = todoChip(item, props.now);
  const age = todoAge(item, props.now);
  const needsYou = section === "needs_you";
  const ticked = item.erikTicked !== null;
  return (
    <View className="gap-2 border-b border-border py-3">
      <View className="flex-row gap-3">
        {needsYou ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: ticked, disabled: !props.canTick || props.busy }}
            accessibilityLabel={item.title}
            accessibilityHint={
              ticked ? "Takes the tick back" : "Tells your personal agent it is done"
            }
            disabled={!props.canTick || props.busy}
            onPress={props.onToggle}
            hitSlop={10}
            className="pt-0.5"
          >
            <SymbolView
              name={ticked ? "checkmark.circle.fill" : "circle"}
              size={24}
              tintColorClassName={ticked ? "accent-primary" : "accent-icon-muted"}
              type="monochrome"
            />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityHint={open ? "Hides the details" : "Shows the details"}
          onPress={() => setOpen((current) => !current)}
          className="min-w-0 flex-1 gap-1.5"
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text
            className={cn(
              "text-base",
              needsYou ? "font-t3-medium" : null,
              section === "done" ? "text-foreground-muted" : "text-foreground",
            )}
          >
            {item.title}
          </Text>
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Chip tone={chip.tone} label={chip.label} />
            {item.repeated > 0 && section !== "done" ? (
              <View className="rounded bg-danger px-1.5 py-0.5">
                <Text className="text-[10px] font-t3-bold uppercase tracking-wide text-danger-foreground">
                  {item.repeated > 1 ? `Repeated ×${item.repeated}` : "Repeated"}
                </Text>
              </View>
            ) : null}
            {age ? <Text className="text-xs text-foreground-tertiary">{age}</Text> : null}
          </View>
        </Pressable>
        <SymbolView
          name={open ? "chevron.up" : "chevron.down"}
          size={14}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </View>
      {open ? (
        <View className={cn("gap-2", needsYou ? "pl-9" : null)}>
          {item.owner && item.owner !== PERSONAL_AGENT_THREAD_ID ? (
            <View className="flex-row flex-wrap items-center gap-1.5">
              <Text className="text-xs text-foreground-tertiary">Owner</Text>
              <ThreadChip
                environmentId={props.environmentId}
                threadId={item.owner}
                onOpen={props.onOpenThread}
              />
            </View>
          ) : null}
          {item.body.length > 0 ? <PullRequestMarkdown markdown={item.body} /> : null}
          <Text className="text-xs text-foreground-tertiary">todo/{item.id}.md</Text>
        </View>
      ) : null}
    </View>
  );
}

function SectionTitle(props: { readonly children: string; readonly attention?: boolean }) {
  return (
    <Text
      className={cn(
        "mt-6 mb-1 text-xs font-t3-bold uppercase tracking-wide",
        props.attention ? "text-warning-foreground" : "text-foreground-tertiary",
      )}
    >
      {props.children}
    </Text>
  );
}

/**
 * The personal agent's one to-do list, read live from its todo/*.md files.
 * Items that wait on the user come first as Needs you; ticking one records it
 * in the file and wakes the personal agent to verify it.
 */
export function AttentionSheet({ route }: StaticScreenProps<AttentionTarget>) {
  const { environmentId } = route.params;
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  const { data, error } = useEnvironmentQuery(
    serverEnvironment.attentionItemsLive({ environmentId, input: {} }),
  );
  const canTick = useAtomValue(
    serverEnvironment.setAttentionItemDone.permissionAtom(environmentId),
  );
  const setTicked = useAtomCommand(serverEnvironment.setAttentionItemDone, "To-do item tick");
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [showFolded, setShowFolded] = useState(false);
  const [tab, setTab] = useState<"todo" | "spoken">("todo");
  const spoken = data?.spoken ?? [];
  const newestSpoken = spoken[0] ? (spoken[0].queuedAt ?? spoken[0].statusAt) : "";
  // What was new when the home opened stays marked while it is open.
  const [seenAt] = useState(() => spokenSeenAt);
  const spokenUnseen = newestSpoken > seenAt;
  useEffect(() => {
    if (newestSpoken > spokenSeenAt) spokenSeenAt = newestSpoken;
  }, [newestSpoken]);

  const toggle = async (item: AttentionItem) => {
    if (item.erikTicked === null)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setBusyIds((current) => new Set(current).add(item.id));
    await setTicked({ environmentId, input: { id: item.id, done: item.erikTicked === null } });
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(item.id);
      return next;
    });
  };
  const openThread = (threadId: ThreadId) => {
    const destination = { environmentId, threadId };
    if (Platform.OS === "android") selectAndroidWorkspace({ name: "Thread", params: destination });
    else navigation.navigate("Thread", destination);
  };

  const items = data?.items ?? [];
  const now = Date.now();
  const bySection = new Map<TodoSection, AttentionItem[]>();
  for (const item of items) {
    const section = todoSection(item, now);
    bySection.set(section, [...(bySection.get(section) ?? []), item]);
  }
  const needsYouCount = bySection.get("needs_you")?.length ?? 0;
  const foldedCount =
    (bySection.get("standing")?.length ?? 0) + (bySection.get("done")?.length ?? 0);

  const section = (key: TodoSection) => {
    const rows = bySection.get(key) ?? [];
    if (rows.length === 0) return null;
    return (
      <View key={key}>
        <SectionTitle attention={key === "needs_you"}>
          {`${SECTION_TITLE[key]} · ${rows.length}`}
        </SectionTitle>
        {rows.map((item) => (
          <TodoRow
            key={item.id}
            environmentId={environmentId}
            item={item}
            now={now}
            canTick={canTick}
            busy={busyIds.has(item.id)}
            onToggle={() => void toggle(item)}
            onOpenThread={openThread}
          />
        ))}
      </View>
    );
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {error ? <Text className="pt-6 text-sm text-danger-foreground">{error}</Text> : null}
      <TodayStrip today={data?.today ?? null} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Chat with your personal agent"
        onPress={() => openThread(PERSONAL_AGENT_THREAD_ID)}
        className="mt-3 flex-row items-center gap-3 rounded-2xl bg-adaptive-violet-500-a12-a16 px-4 py-3"
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <SymbolView
          name="bubble.left"
          size={18}
          tintColorClassName="accent-adaptive-violet-600-400"
          type="monochrome"
        />
        <Text className="flex-1 text-base font-t3-medium text-foreground">Chat</Text>
        <SymbolView
          name="chevron.right"
          size={14}
          tintColorClassName="accent-adaptive-violet-600-400"
          type="monochrome"
        />
      </Pressable>
      <View accessibilityRole="tablist" className="mt-4 flex-row rounded-full bg-subtle p-1">
        {(
          [
            ["todo", needsYouCount > 0 ? `To-do · ${needsYouCount} need you` : "To-do"],
            ["spoken", spokenUnseen ? "Said aloud · new" : "Said aloud"],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            onPress={() => setTab(value)}
            className={cn(
              "flex-1 items-center rounded-full py-2",
              tab === value ? "bg-subtle-strong" : null,
            )}
          >
            <Text
              className={cn(
                "text-sm font-t3-medium",
                tab === value ? "text-foreground" : "text-foreground-muted",
              )}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === "spoken" ? (
        <SpokenFeed environmentId={environmentId} spoken={spoken} seenAt={seenAt} />
      ) : null}
      {tab === "todo" && !error && items.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          Nothing on the list. Your personal agent keeps it in its todo/ folder.
        </Text>
      ) : null}
      {tab === "todo" ? section("needs_you") : null}
      {tab === "todo" ? section("moving") : null}
      {tab === "todo" ? section("waiting") : null}
      {tab === "todo" && foldedCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showFolded }}
          onPress={() => setShowFolded((current) => !current)}
          className="mt-6 flex-row items-center gap-1.5 py-2"
        >
          <SymbolView
            name={showFolded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
          <Text className="text-xs font-t3-bold uppercase tracking-wide text-foreground-tertiary">
            {`Standing rules and done · ${foldedCount}`}
          </Text>
        </Pressable>
      ) : null}
      {tab === "todo" && showFolded ? (
        <>
          {section("standing")}
          {section("done")}
        </>
      ) : null}
    </ScrollView>
  );

  const title = "Personal agent";

  if (Platform.OS === "ios") {
    // A formSheet screen never renders a stack header, so it comes from a
    // nested native stack inside the sheet, like the queue sheet.
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View collapsable={false} className="flex-1 bg-sheet">
          <ScreenStack style={{ flex: 1 }}>
            <Screen
              activityState={2}
              enabled
              isNativeStack
              screenId="attention-sheet-native"
              scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
              style={{ backgroundColor: theme["--color-sheet"], flex: 1 }}
            >
              {content}
              <ScreenStackHeaderConfig
                backgroundColor="rgba(0,0,0,0)"
                color={theme["--color-foreground"]}
                hideBackButton
                hideShadow={false}
                title={title}
                titleColor={theme["--color-foreground"]}
                titleFontSize={18}
                titleFontWeight="800"
                translucent
              />
            </Screen>
          </ScreenStack>
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View collapsable={false} className="flex-1 bg-sheet">
        <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
        <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
      </View>
    </GestureHandlerRootView>
  );
}
