import { useAtomValue } from "@effect/atom-react";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { splitCommitmentProof } from "@t3tools/client-runtime/commitment-proof";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  PERSONAL_AGENT_THREAD_ID,
  type AttentionItem,
  type CommitmentState,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useState } from "react";
import { Linking, Platform, Pressable, ScrollView, View } from "react-native";
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
import { useAssetUrl } from "../../state/assets";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const URL_PATTERN = /https?:\/\/[^\s)]+/g;

export type AttentionTarget = { readonly environmentId: EnvironmentId };
type AttentionTab = "needs_you" | "in_flight";

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
  return data?.items.filter((item) => item.kind === "needs_you" && !item.done).length ?? 0;
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

const STATE_LABEL: Record<CommitmentState, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting on you",
  done: "Done",
};

const STATE_CLASS: Record<CommitmentState, { readonly box: string; readonly text: string }> = {
  open: { box: "bg-subtle", text: "text-foreground-muted" },
  in_progress: { box: "bg-subtle-strong", text: "text-primary-text" },
  waiting: { box: "bg-warning", text: "text-warning-foreground" },
  done: { box: "bg-subtle", text: "text-foreground-muted" },
};

function Badge(props: { readonly box: string; readonly text: string; readonly label: string }) {
  return (
    <View className={cn("rounded px-1.5 py-0.5", props.box)}>
      <Text className={cn("text-[10px] font-t3-bold uppercase tracking-wide", props.text)}>
        {props.label}
      </Text>
    </View>
  );
}

function ProofImage(props: {
  readonly environmentId: EnvironmentId;
  readonly source: string;
  readonly local: boolean;
}) {
  const assetUrl = useAssetUrl(
    props.environmentId,
    props.local
      ? { _tag: "media-file", threadId: PERSONAL_AGENT_THREAD_ID, path: props.source }
      : null,
  );
  const url = props.local ? assetUrl : props.source;
  const name = props.source.split("/").pop() ?? props.source;
  if (url === null) {
    return <Text className="text-xs text-foreground-muted">{name}</Text>;
  }
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open proof ${name}`}
      onPress={() => void Linking.openURL(url)}
      className="w-[48%] overflow-hidden rounded-lg border border-border"
    >
      <Image
        source={{ uri: url }}
        contentFit="cover"
        contentPosition="top"
        style={{ height: 120 }}
      />
    </Pressable>
  );
}

function ProofView(props: { readonly environmentId: EnvironmentId; readonly proof: string }) {
  const parts = splitCommitmentProof(props.proof);
  const images = parts.flatMap((part) => (part.type === "image" ? [part] : []));
  return (
    <View className="gap-1.5">
      <Text className="text-sm text-foreground-muted">
        <Text className="text-sm font-t3-medium text-foreground-secondary">Proof: </Text>
        {parts.map((part, index) =>
          part.type === "text" ? (
            part.text
          ) : part.type === "link" ? (
            <Text
              key={index}
              className="text-sm text-md-link underline"
              onPress={() => void Linking.openURL(part.url)}
            >
              {part.url}
            </Text>
          ) : (
            <Text key={index}>{part.source.split("/").pop()}</Text>
          ),
        )}
      </Text>
      {images.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {images.map((image) => (
            <ProofImage
              key={image.source}
              environmentId={props.environmentId}
              source={image.source}
              local={image.local}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A commitment the personal agent owns. Only the agent closes it, with proof. */
function InFlightRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: AttentionItem;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  return (
    <View className="gap-1.5 border-b border-border py-3">
      <View className="flex-row flex-wrap items-center gap-1.5">
        <Badge {...STATE_CLASS[item.state]} label={STATE_LABEL[item.state]} />
        {item.repeated ? (
          <Badge box="bg-danger" text="text-danger-foreground" label="Repeated" />
        ) : null}
        {item.askedAt ? (
          <Text className="ml-auto text-xs text-foreground-tertiary">Asked {item.askedAt}</Text>
        ) : null}
      </View>
      <Text
        className={cn(
          "text-base font-t3-medium",
          item.done ? "text-foreground-muted" : "text-foreground",
        )}
      >
        {item.title}
      </Text>
      {item.detail && !item.done ? <DetailText text={item.detail} /> : null}
      {item.ownerThreadId ? (
        <View className="flex-row flex-wrap items-center gap-1.5">
          <Text className="text-xs text-foreground-tertiary">Owner</Text>
          <ThreadChip
            environmentId={props.environmentId}
            threadId={item.ownerThreadId}
            onOpen={props.onOpenThread}
          />
        </View>
      ) : null}
      {item.proofRequired && !item.done ? (
        <Text className="text-sm text-foreground-muted">
          <Text className="text-sm font-t3-medium text-foreground-secondary">Proof needed: </Text>
          {item.proofRequired}
        </Text>
      ) : null}
      {item.proof && item.done ? (
        <ProofView environmentId={props.environmentId} proof={item.proof} />
      ) : null}
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Text className="mt-6 mb-1 text-xs font-t3-medium text-foreground-tertiary">{children}</Text>
  );
}

/**
 * The personal agent's two lists: Needs you (what only the user can do) and
 * In flight (what the agent has committed to and owns until it is proven done).
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
  const canOperate = useAtomValue(
    serverEnvironment.setAttentionItemDone.permissionAtom(environmentId),
  );
  const setDone = useAtomCommand(serverEnvironment.setAttentionItemDone, "Needs you item done");
  const dismiss = useAtomCommand(serverEnvironment.dismissAttentionItem, "Needs you item remove");
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<AttentionTab>("needs_you");

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
  const needsYou = items.filter((item) => item.kind === "needs_you");
  const open = needsYou.filter((item) => !item.done);
  const done = needsYou.filter((item) => item.done);
  const inFlight = items.filter((item) => item.kind === "in_flight");
  const inFlightOpen = inFlight.filter((item) => !item.done);
  const inFlightDone = inFlight.filter((item) => item.done);
  const inFlightRow = (item: AttentionItem) => (
    <InFlightRow
      key={item.id}
      environmentId={environmentId}
      item={item}
      onOpenThread={openThread}
    />
  );
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

  const needsYouLabel = open.length > 0 ? `Needs you · ${open.length}` : "Needs you";
  const inFlightLabel =
    inFlightOpen.length > 0 ? `In flight · ${inFlightOpen.length}` : "In flight";
  const tabButton = (value: AttentionTab, label: string) => (
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
  );

  const content = (
    <View className="flex-1">
      <View accessibilityRole="tablist" className="mx-5 mt-2 flex-row rounded-full bg-subtle p-1">
        {tabButton("needs_you", needsYouLabel)}
        {tabButton("in_flight", inFlightLabel)}
      </View>
      <ScrollView
        nestedScrollEnabled
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerClassName="px-5"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
      >
        {error ? <Text className="pt-6 text-sm text-danger-foreground">{error}</Text> : null}
        {tab === "needs_you" ? (
          <>
            {!error && open.length === 0 ? (
              <Text className="pt-6 text-center text-sm text-foreground-muted">
                Nothing needs you right now. Your personal agent adds sign-ins, decisions and
                questions here when work is waiting on you.
              </Text>
            ) : null}
            {open.map(row)}
            {done.length > 0 ? (
              <>
                <SectionTitle>Done this week</SectionTitle>
                {done.map(row)}
              </>
            ) : null}
          </>
        ) : (
          <>
            {!error && inFlightOpen.length === 0 ? (
              <Text className="pt-6 text-center text-sm text-foreground-muted">
                Nothing in flight. What you ask your personal agent for is tracked here until it is
                done and proven.
              </Text>
            ) : null}
            {inFlightOpen.map(inFlightRow)}
            {inFlightDone.length > 0 ? (
              <>
                <SectionTitle>Delivered this week</SectionTitle>
                {inFlightDone.map(inFlightRow)}
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );

  const title = tab === "needs_you" ? needsYouLabel : inFlightLabel;

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
