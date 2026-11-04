import { sidebarIndentStyle } from "./indent";
import { useSidebarRowDensity } from "@/components/sidebar/use-sidebar-row-density";
import { useCallback, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { sidebarWorkspaceRowStyles } from "@/components/sidebar/sidebar-workspace-row-content";
import { DensityIcon } from "@/components/ui/density-icon";
import { density as densityTokens, densityIconBox } from "@/styles/density";

/**
 * A list row that acts rather than opens a workspace, such as "Show more" or Factory's
 * Overview. It is a workspace row that happens to say something else, so it takes the
 * workspace row's geometry — height, padding, radius, and both fills — rather than a set of
 * its own. Sitting under a column of rows, anything it does differently reads as a mistake
 * rather than as a distinction.
 *
 * `indented` because the two groupings disagree: status rows sit on their header's label rail and
 * project rows sit inside their project heading, so the caller says which list this row belongs
 * to. The indent itself is the workspace row's, imported rather than re-derived.
 */
export function SidebarListActionRow({
  icon,
  label,
  accessibilityLabel,
  onPress,
  indented = false,
  level = 1,
  testID,
}: {
  icon: ComponentProps<typeof DensityIcon>["icon"];
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  indented?: boolean;
  /** Project-mode hierarchy level of the rows around this one. */
  level?: number;
  testID: string;
}) {
  const density = useSidebarRowDensity();
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      density,
      !indented && sidebarIndentStyle(level),
      indented && sidebarWorkspaceRowStyles.rowIndented,
      hovered && !pressed && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [indented, level, density],
  );

  return (
    <Pressable
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={rowStyle}
      testID={testID}
    >
      {({ hovered, pressed }) => (
        <>
          <View style={styles.iconSlot}>
            <DensityIcon
              icon={icon}
              size="sm"
              color={hovered || pressed ? "foreground" : "foregroundMuted"}
            />
          </View>
          <Text style={hovered || pressed ? styles.textHovered : styles.text} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** The row that ends a truncated group. */
export function SidebarGroupToggleRow({
  expanded,
  onPress,
  indented = false,
  level = 1,
  testID,
}: {
  expanded: boolean;
  onPress: () => void;
  indented?: boolean;
  /** Project-mode hierarchy level of the rows this toggle extends. */
  level?: number;
  testID: string;
}) {
  const { t } = useTranslation();
  return (
    <SidebarListActionRow
      icon={expanded ? ChevronUp : ChevronDown}
      label={t(
        expanded ? "sidebar.workspace.actions.showLess" : "sidebar.workspace.actions.showMore",
      )}
      onPress={onPress}
      indented={indented}
      level={level}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  // Kept in step with `workspaceRow` in sidebar-workspace-list.tsx and sidebar-status-list.tsx.
  row: {
    minHeight: densityTokens.rowHeight,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  // The width of a workspace row's status slot, so the label lands on the same rail as the
  // titles above it rather than two points to their left.
  iconSlot: {
    width: densityIconBox("md"),
    height: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
  },
  textHovered: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
  },
}));
