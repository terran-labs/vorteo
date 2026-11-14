import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

/**
 * A top-level settings group, such as This device or Vorteo: a full-width rule with a small
 * uppercase label under it. The line matches the sidebar's section rules and the label matches
 * the sidebar's Factory subheadings (`components/sidebar/factory-subheading.tsx`), so the settings
 * page groups content the same way the app sidebar does.
 */
export function SettingsRuleHeading({
  label,
  level = 2,
  testID,
}: {
  label: string;
  /** The heading level announced to assistive technology. */
  level?: number;
  testID?: string;
}) {
  const webHeading = isWeb ? ({ "aria-level": level } as const) : null;
  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.rule} />
      <Text {...webHeading} accessibilityRole="header" style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2], marginBottom: theme.spacing[4] },
  rule: { height: theme.borderWidth[1], backgroundColor: theme.colors.divider },
  label: {
    // Lines up with the section and pane titles, which sit inset from their cards.
    marginLeft: theme.spacing[1],
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
}));
