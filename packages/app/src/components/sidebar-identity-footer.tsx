import { useCallback, useState } from "react";
import { Text, View, type LayoutChangeEvent, type PressableStateCallbackType } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { hoverStyle } from "@/styles/hover";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { useFooterLeadingRule } from "@/components/sidebar/footer-rules";
import { SidebarSectionRule } from "@/components/sidebar/sidebar-separator";
import { useInstallationName } from "@/execution-installation/installation-name";
import { resolveAppVersion } from "@/utils/app-version";
import { formatLiveVersionSuffix } from "@/utils/live-revision";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { useVortonUpdate } from "@/vorton-updates/use-update";
import { SidebarFooterQuota } from "@/provider-usage/footer-quota";
import { FLOATING_PANEL_CONTROL_HEIGHT, FLOATING_PANEL_RADIUS } from "@/styles/floating-panel";

/**
 * The same compact row closes the main and settings sidebars. On the left, one block names the
 * installation over its version and opens Maintenance, where update status lives. On the right,
 * the quota timelines open every account's quotas.
 */
export function SidebarIdentityFooter({
  onOpenUpdates,
  versionTestID = "sidebar-version",
}: {
  /** Settings selects its own section; elsewhere the footer navigates there. */
  onOpenUpdates?: () => void;
  versionTestID?: string;
}) {
  const name = useInstallationName();
  const rule = useFooterLeadingRule("identity");
  const { checkNow } = useVortonUpdate();
  const appVersion = resolveAppVersion();
  // In Live dev, committed work since the running version's release shows as `+N`.
  const versionText = `${formatVersionWithPrefix(
    appVersion,
  )}${formatLiveVersionSuffix(appVersion)}`;
  const [rowWidth, setRowWidth] = useState(0);
  const [identityWidth, setIdentityWidth] = useState(0);
  const measureRow = useCallback((event: LayoutChangeEvent) => {
    setRowWidth(Math.floor(event.nativeEvent.layout.width));
  }, []);
  // The block never shrinks, so its width only changes with its text, not while dragging.
  const measureIdentity = useCallback((event: LayoutChangeEvent) => {
    setIdentityWidth(Math.ceil(event.nativeEvent.layout.width));
  }, []);
  const openUpdates = useCallback(() => {
    if (onOpenUpdates) {
      onOpenUpdates();
      return;
    }
    checkNow();
    router.push(buildSettingsSectionRoute("maintenance"));
  }, [onOpenUpdates, checkNow]);
  return (
    <>
      {rule ? <SidebarSectionRule /> : null}
      <View style={styles.footer} onLayout={measureRow} testID="sidebar-identity-footer">
        <PressHighlight
          onPress={openUpdates}
          accessibilityRole="button"
          accessibilityLabel={`${name}, ${versionText}. Check for updates`}
          style={identityStyle}
          onLayout={measureIdentity}
          testID={versionTestID}
        >
          <Text style={styles.name} numberOfLines={1} testID="sidebar-installation-name">
            {name}
          </Text>
          <Text style={styles.version} numberOfLines={1}>
            {versionText}
          </Text>
        </PressHighlight>
        <SidebarFooterQuota rowWidth={rowWidth} identityWidth={identityWidth} />
      </View>
    </>
  );
}

// Hover is browser-owned CSS so it clears when the sidebar reflows under a resting cursor.
function identityStyle({ pressed }: PressableStateCallbackType) {
  return [styles.identity, styles.identityHoverable, pressed && styles.identityHovered];
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
    // Like the toolbar above, the buttons reach the card's inner edge so their highlights nest
    // just inside its border; the text keeps its distance through the buttons' own padding.
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  // Ghost-button chrome around a two-line block, the toolbar buttons' height and radius.
  identity: {
    flexShrink: 0,
    maxWidth: "45%",
    minHeight: FLOATING_PANEL_CONTROL_HEIGHT,
    justifyContent: "center",
    borderRadius: FLOATING_PANEL_RADIUS,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  identityHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  identityHoverable: hoverStyle({
    backgroundColor: theme.colors.surfaceSidebarHover,
  }),
  name: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  version: {
    fontSize: theme.fontSize.sm - 1,
    color: theme.colors.foregroundExtraMuted,
  },
}));
