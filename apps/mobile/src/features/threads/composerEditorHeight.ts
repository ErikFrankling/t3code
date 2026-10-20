import { useWindowDimensions } from "react-native";

/**
 * How tall a composer's text grows before it scrolls: about a third of the
 * window, so a long message can be edited in place and the composer still fits
 * above the keyboard.
 */
export function useComposerEditorMaxHeight(): number {
  const { height } = useWindowDimensions();
  return Math.max(160, Math.round(height * 0.35));
}
