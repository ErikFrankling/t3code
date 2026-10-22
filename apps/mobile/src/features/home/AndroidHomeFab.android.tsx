import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NewThreadButton } from "../../components/NewThreadButton";
import {
  androidHomeFabPosition,
  type AndroidHomeFabLayout as SharedAndroidHomeFabLayout,
} from "./AndroidHomeFab.shared";
import { useWorkspaceState } from "../../state/workspace";
import { FabScrollContext } from "./FabScrollContext";
import { updateFabScroll } from "./fab-scroll";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { useEnabledNavigationTabs } from "../workspace/navigation-tabs";
import { WorkspaceTabsContext, useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { FLOATING_TABS, floatingTabsMetrics } from "../workspace/floating-workspace-tabs";
import {
  useAppearancePreferences,
  useAndroidFloatingTabs,
} from "../settings/appearance/AppearancePreferencesProvider";
import { setFloatingButtonTop } from "../voice-input/floatingClearance";

export function AndroidHomeFabLayout(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const insets = useSafeAreaInsets();
  const { appearance } = useAppearancePreferences();
  const { fontScale } = useWindowDimensions();
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null);
  const { state } = useWorkspaceState();
  const [expanded, setExpanded] = useState(true);
  const { scale, fabSize } = useAndroidControlSizing();
  const tabs = useEnabledNavigationTabs();
  const floating = floatingTabsMetrics(
    tabs.length + 1,
    scale,
    fabSize,
    props.paneWidth ?? layoutWidth ?? undefined,
  );
  const workspace = useWorkspaceTabs();
  const bottomClearance =
    insets.bottom +
    FLOATING_TABS.bottom +
    FLOATING_TABS.edge +
    Math.max(floating.height, floating.fabOffset + fabSize);
  const context = useMemo(
    () => (floatingTabsEnabled && workspace ? { ...workspace, bottomClearance } : workspace),
    [floatingTabsEnabled, workspace, bottomClearance],
  );
  const scrollState = useRef({ anchor: 0, expanded: true });
  const fabRef = useRef<ViewInstance>(null);
  const showsFab =
    !props.disabled &&
    (!props.sidebar || floatingTabsEnabled) &&
    state.hasConnections &&
    layoutWidth !== null;
  useEffect(() => {
    if (!showsFab) setFloatingButtonTop(null);
    return () => setFloatingButtonTop(null);
  }, [showsFab]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const next = updateFabScroll(
      scrollState.current,
      contentOffset.y,
      contentSize.height - layoutMeasurement.height,
    );
    if (next.expanded !== scrollState.current.expanded) setExpanded(next.expanded);
    scrollState.current = next;
  }, []);

  // Remount only the FAB when its font or pane changes to clear the cached expanded width.
  // Floating navigation shares this row; Material split views put New thread in the rail.
  return (
    <View className="flex-1" onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}>
      <WorkspaceTabsContext value={context}>
        <FabScrollContext value={onScroll}>{props.children}</FabScrollContext>
      </WorkspaceTabsContext>
      {showsFab ? (
        // The wrapper reports where the button is, so the dictation pill stays above it.
        <View
          ref={fabRef}
          className="absolute"
          style={
            floatingTabsEnabled
              ? {
                  right: FLOATING_TABS.edge,
                  bottom: insets.bottom + FLOATING_TABS.bottom + floating.fabOffset,
                }
              : androidHomeFabPosition(insets.bottom, props.sidebar)
          }
          onLayout={() => fabRef.current?.measureInWindow((_x, y) => setFloatingButtonTop(y))}
        >
          <NewThreadButton
            key={`${appearance.baseFontSize}:${fontScale}:${layoutWidth}`}
            extended
            expanded={floatingTabsEnabled ? false : expanded}
            onPress={props.onStartNewTask}
          />
        </View>
      ) : null}
    </View>
  );
}
