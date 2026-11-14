import { createContext, useContext, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsInfoTip } from "@/components/settings/headings/settings-info-tip";
import { CardHeaderStatus } from "@/components/ui/card-header-status";
import { settingsStyles } from "@/styles/settings";
import { isWeb } from "@/constants/platform";

const ExpansionDepth = createContext(0);

/** In-place details belong to their parent, rather than becoming sibling sections. */
export function SettingsExpansion({ children, testID }: { children: ReactNode; testID?: string }) {
  const depth = useContext(ExpansionDepth);
  return (
    <ExpansionDepth.Provider value={depth + 1}>
      <View testID={testID} style={[styles.region, depth > 0 && styles.nested]}>
        {children}
      </View>
    </ExpansionDepth.Provider>
  );
}

// React Native Web renders a header role without a level as h1. Groups inside an expanded
// card sit under the pane's sections, so they are level 4.
const headingLevel = isWeb ? ({ "aria-level": 4 } as object) : {};

const styles = StyleSheet.create((theme) => ({
  region: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[4],
  },
  nested: { backgroundColor: theme.colors.surface3 },
  header: { gap: theme.spacing[2] },
  headerTitle: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexShrink: 1 },
  headerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  spacer: { flex: 1 },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
}));

/**
 * Names a group of rows inside an expanded card, such as a provider's Connections or Profiles,
 * without nesting another card. It is a divided row like its neighbours: a medium label, an
 * optional info tip and status, and the group's actions at the end. Actions are outline
 * buttons so they read as buttons beside passive labels.
 */
export function SettingsExpansionHeader({
  title,
  info,
  status,
  trailing,
  testID,
}: {
  title: string;
  info?: ReactNode;
  status?: string | null;
  trailing?: ReactNode;
  testID?: string;
}) {
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.header]} testID={testID}>
      <View style={styles.headerTitle}>
        <Text
          style={styles.headerText}
          numberOfLines={1}
          accessibilityRole="header"
          {...headingLevel}
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
      {status !== undefined ? <CardHeaderStatus text={status} /> : <View style={styles.spacer} />}
      {trailing ? <View style={styles.actions}>{trailing}</View> : null}
    </View>
  );
}
