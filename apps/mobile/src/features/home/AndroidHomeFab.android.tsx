import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
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
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { setFloatingButtonTop } from "../voice-input/floatingClearance";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";

export function AndroidHomeFabLayout(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const insets = useSafeAreaInsets();
  const { appearance } = useAppearancePreferences();
  const { fontScale } = useWindowDimensions();
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null);
  const { state } = useWorkspaceState();
  const [expanded, setExpanded] = useState(true);
  const scrollState = useRef({ anchor: 0, expanded: true });
  const { fabSize } = useAndroidControlSizing();
  const containerRef = useRef<ViewInstance>(null);
  const [containerBottom, setContainerBottom] = useState<number | null>(null);
  const showsFab =
    !props.disabled && !props.sidebar && state.hasConnections && layoutWidth !== null;
  const fabPosition = androidHomeFabPosition(insets.bottom, props.sidebar);
  // Where the button starts in the window, so the dictation pill stays above it.
  const fabTop =
    showsFab && containerBottom !== null ? containerBottom - fabPosition.bottom - fabSize : null;
  useEffect(() => {
    setFloatingButtonTop(fabTop);
    return () => setFloatingButtonTop(null);
  }, [fabTop]);
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
  // The split-view sidebar has no FAB: the navigation rail carries New thread. On phones it
  // keeps Material's 16dp corner margin; the bottom bar already consumes the gesture inset.
  return (
    <View
      ref={containerRef}
      className="flex-1"
      onLayout={(event) => {
        setLayoutWidth(event.nativeEvent.layout.width);
        // Measured here, not on the button: the native button has no size of its
        // own inside a wrapper and vanishes.
        containerRef.current?.measureInWindow((_x, y, _width, height) =>
          setContainerBottom(y + height),
        );
      }}
    >
      <FabScrollContext value={onScroll}>{props.children}</FabScrollContext>
      {showsFab ? (
        <NewThreadButton
          key={`${appearance.baseFontSize}:${fontScale}:${layoutWidth}`}
          extended
          expanded={expanded}
          onPress={props.onStartNewTask}
          className="absolute"
          style={fabPosition}
        />
      ) : null}
    </View>
  );
}
