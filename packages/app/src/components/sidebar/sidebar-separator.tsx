import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { createContext, useContext, type ReactNode } from "react";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export const SidebarInsetContext = createContext(0);

/**
 * Extend through the sidebar's shared inset without moving padded content.
 * Overlay edges preserve header and footer geometry while spacing animates.
 */
export function SidebarSeparator({
  testID,
  edge,
}: { testID?: string; edge?: "top" | "bottom" } = {}) {
  const inset = useContext(SidebarInsetContext);
  return (
    <View
      pointerEvents="none"
      style={[
        styles.line,
        inlineUnistylesStyle(
          edge
            ? { position: "absolute" as const, left: -inset, right: -inset, [edge]: 0 }
            : { marginHorizontal: -inset },
        ),
      ]}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
}));

/**
 * The full-width rule between sections of the sidebar footer block. It reaches the card's edges
 * through the sidebar inset, and the line sits on the row's top edge so a scrolling section above
 * is clipped exactly at the line. A resizable section passes its height handle as `children`,
 * which overlays the line so the rule itself is the grip.
 */
export function SidebarSectionRule({
  testID,
  lineHidden = false,
  children,
}: {
  testID?: string;
  /** Keeps the row and any grip but draws no line, as where nothing sits above it. */
  lineHidden?: boolean;
  children?: ReactNode;
}) {
  const inset = useContext(SidebarInsetContext);
  return (
    <View
      style={[ruleStyles.row, inlineUnistylesStyle({ marginHorizontal: -inset })]}
      testID={testID}
    >
      {lineHidden ? null : <View pointerEvents="none" style={ruleStyles.line} />}
      {children}
    </View>
  );
}

const ruleStyles = StyleSheet.create((theme) => ({
  // Only the line takes space; a resize grip overlays it without pushing the section down.
  row: { height: theme.borderWidth[1], flexShrink: 0, zIndex: 1 },
  line: { height: theme.borderWidth[1], backgroundColor: theme.colors.divider },
}));
