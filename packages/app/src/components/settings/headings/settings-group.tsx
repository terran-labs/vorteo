import { useMemo, type ReactNode } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsHeadingLevel, useSettingsHeadingLevel, webHeadingLevel } from "./heading-level";
import { SettingsInfoTip } from "./settings-info-tip";

interface SettingsGroupProps {
  title: string;
  info?: ReactNode;
  trailing?: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

/**
 * Top-level grouping above one or more SettingsSection blocks. Use when a
 * settings screen has more than one logical area — the group title carries the
 * category, the optional info tooltip explains it, and the inner sections keep
 * their muted iOS-style labels.
 */
export function SettingsGroup({
  title,
  info,
  trailing,
  testID,
  style,
  children,
}: SettingsGroupProps) {
  // The group title takes the current level; its sections take the next.
  const level = useSettingsHeadingLevel();
  const groupStyle = useMemo(() => [styles.group, style], [style]);
  return (
    <View style={groupStyle} testID={testID}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text
            {...webHeadingLevel(level)}
            accessibilityRole="header"
            style={styles.title}
            numberOfLines={1}
          >
            {title}
          </Text>
          {info ? (
            <SettingsInfoTip
              title={title}
              info={info}
              testID={testID ? `${testID}-info` : undefined}
            />
          ) : null}
        </View>
        {trailing}
      </View>
      <SettingsHeadingLevel.Provider value={level + 1}>{children}</SettingsHeadingLevel.Provider>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: {
    marginBottom: theme.spacing[6],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
}));
