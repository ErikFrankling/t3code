import { useWindowDimensions } from "react-native";

/**
 * How tall a composer's text grows before it scrolls: at least six lines, and
 * otherwise about a third of the window, so a long message can be read and
 * edited in place while the composer still fits above the keyboard.
 */
export function useComposerEditorMaxHeight(lineHeight: number): number {
  const { height } = useWindowDimensions();
  return Math.max(Math.ceil(lineHeight * 6) + 8, Math.round(height * 0.35));
}
