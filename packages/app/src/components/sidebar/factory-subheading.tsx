import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { sidebarIndentStyle } from "./indent";

/**
 * A label inside a Factory section, such as Crew or Runners: one level under the section row,
 * with its items one level further in. No divider; the label alone groups what follows.
 */
export function FactorySubheading({
  label,
  level,
  trailing,
  testID,
}: {
  label: string;
  level: number;
  trailing?: ReactNode;
  testID?: string;
}) {
  return (
    <View
      pointerEvents="none"
      accessibilityRole="header"
      style={[styles.row, sidebarIndentStyle(level)]}
      testID={testID}
    >
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {trailing ? <Text style={styles.label}>{trailing}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  label: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
}));
