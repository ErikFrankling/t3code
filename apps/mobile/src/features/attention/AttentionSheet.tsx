import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AttentionItem, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const URL_PATTERN = /https?:\/\/[^\s)]+/g;

export type AttentionTarget = { readonly environmentId: EnvironmentId };

/** Open items for the card's count. Null while the server lacks the list. */
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
  return data?.items.filter((item) => !item.done).length ?? 0;
}

function DetailText({ text }: { text: string }) {
  const parts: Array<string | { url: string }> = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    parts.push(text.slice(last, match.index), { url: match[0] });
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return (
    <Text className="text-sm text-foreground-muted">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          <Text
            key={index}
            className="text-sm text-md-link underline"
            onPress={() => void Linking.openURL(part.url)}
          >
            {part.url}
          </Text>
        ),
      )}
    </Text>
  );
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

function AttentionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: AttentionItem;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onDismiss: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  return (
    <View className="flex-row gap-3 border-b border-border py-3">
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.done, disabled: props.busy }}
        accessibilityLabel={item.title}
        accessibilityHint={
          item.done ? "Puts it back on the list" : "Tells your personal agent it is done"
        }
        disabled={props.busy}
        onPress={props.onToggle}
        hitSlop={10}
        className="pt-0.5"
      >
        <SymbolView
          name={item.done ? "checkmark.circle.fill" : "circle"}
          size={24}
          tintColorClassName={item.done ? "accent-primary" : "accent-icon-muted"}
          type="monochrome"
        />
      </Pressable>
      <View className="min-w-0 flex-1 gap-1.5">
        <Text
          className={cn(
            "text-base font-t3-medium",
            item.done
              ? "text-foreground-muted line-through"
              : item.priority === "high"
                ? "text-danger-foreground"
                : "text-foreground",
          )}
        >
          {item.title}
        </Text>
        {item.detail && !item.done ? <DetailText text={item.detail} /> : null}
        {item.unblocks.length > 0 && !item.done ? (
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Text className="text-xs text-foreground-tertiary">Unblocks</Text>
            {item.unblocks.map((threadId) => (
              <ThreadChip
                key={threadId}
                environmentId={props.environmentId}
                threadId={threadId}
                onOpen={props.onOpenThread}
              />
            ))}
          </View>
        ) : null}
        {item.sourceThreadId && !item.done ? (
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Text className="text-xs text-foreground-tertiary">From</Text>
            <ThreadChip
              environmentId={props.environmentId}
              threadId={item.sourceThreadId}
              onOpen={props.onOpenThread}
            />
          </View>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${item.title}`}
        disabled={props.busy}
        onPress={props.onDismiss}
        hitSlop={10}
        className="pt-1"
        style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
      >
        <SymbolView
          name="xmark"
          size={16}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

/** The personal agent's Needs you list: what only the user can do. */
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
  const canOperate = useAtomValue(
    serverEnvironment.setAttentionItemDone.permissionAtom(environmentId),
  );
  const setDone = useAtomCommand(serverEnvironment.setAttentionItemDone, "Needs you item done");
  const dismiss = useAtomCommand(serverEnvironment.dismissAttentionItem, "Needs you item remove");
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyIds((current) => new Set(current).add(id));
    await action();
    setBusyIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };
  const openThread = (threadId: ThreadId) => {
    const destination = { environmentId, threadId };
    if (Platform.OS === "android") selectAndroidWorkspace({ name: "Thread", params: destination });
    else navigation.navigate("Thread", destination);
  };

  const items = data?.items ?? [];
  const open = items.filter((item) => !item.done);
  const done = items.filter((item) => item.done);
  const row = (item: AttentionItem) => (
    <AttentionRow
      key={item.id}
      environmentId={environmentId}
      item={item}
      busy={!canOperate || busyIds.has(item.id)}
      onToggle={() => {
        if (!item.done) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        void run(item.id, () =>
          setDone({ environmentId, input: { id: item.id, done: !item.done } }),
        );
      }}
      onDismiss={() => void run(item.id, () => dismiss({ environmentId, input: { id: item.id } }))}
      onOpenThread={openThread}
    />
  );

  const content = (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {error ? <Text className="pt-6 text-sm text-danger-foreground">{error}</Text> : null}
      {!error && open.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          Nothing needs you right now. Your personal agent adds sign-ins, decisions and questions
          here when work is waiting on you.
        </Text>
      ) : null}
      {open.map(row)}
      {done.length > 0 ? (
        <>
          <Text className="mt-6 mb-1 text-xs font-t3-medium text-foreground-tertiary">
            Done this week
          </Text>
          {done.map(row)}
        </>
      ) : null}
    </ScrollView>
  );

  const title = open.length > 0 ? `Needs you · ${open.length}` : "Needs you";

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
        <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
        <AndroidSheetHeader title={title} onBack={() => navigation.goBack()} />
        <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
      </View>
    </GestureHandlerRootView>
  );
}
