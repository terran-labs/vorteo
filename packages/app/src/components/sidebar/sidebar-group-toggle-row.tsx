import { sidebarIndentStyle } from "./indent";
import { useSidebarRowDensity } from "@/components/sidebar/use-sidebar-row-density";
import { useCallback, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { sidebarWorkspaceRowStyles } from "@/components/sidebar/sidebar-workspace-row-content";
import { DensityIcon } from "@/components/ui/density-icon";
import { density as densityTokens, densityIconBox, densityIconProps } from "@/styles/density";
import { groupHoverStyle, hoverGroup, hoverStyle } from "@/styles/hover";

const ROW_HOVER_GROUP = "list-action-row";

type ActionIcon = ComponentProps<typeof DensityIcon>["icon"];

/** Strokes with the CSS color of its slot, so web hover can recolor it without JS state. */
function CurrentColorGlyph({ icon: Icon, size }: { icon: ActionIcon; size: number }) {
  return <Icon size={size} color="currentColor" />;
}
const ThemedCurrentColorGlyph = withUnistyles(CurrentColorGlyph);
const currentColorGlyphProps = densityIconProps("sm", () => ({}));

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
  icon: ActionIcon;
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
    // Hover is CSS on the row's hover group; it steps aside while pressed, since :hover outranks
    // the base class.
    ({ pressed }: PressableStateCallbackType) => [
      styles.row,
      density,
      !indented && sidebarIndentStyle(level),
      indented && sidebarWorkspaceRowStyles.rowIndented,
      pressed ? styles.rowPressed : styles.rowHoverable,
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
      {({ pressed }) => (
        <>
          <View style={[styles.iconSlot, pressed && styles.iconSlotPressed]}>
            {isWeb ? (
              <ThemedCurrentColorGlyph icon={icon} uniProps={currentColorGlyphProps} />
            ) : (
              <DensityIcon
                icon={icon}
                size="sm"
                color={pressed ? "foreground" : "foregroundMuted"}
              />
            )}
          </View>
          <Text style={pressed ? styles.textHovered : styles.text} numberOfLines={1}>
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
    ...hoverGroup(ROW_HOVER_GROUP),
  },
  rowHoverable: hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover }),
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
    ...groupHoverStyle(
      ROW_HOVER_GROUP,
      { color: theme.colors.foreground },
      { color: theme.colors.foregroundMuted },
    ),
  },
  iconSlotPressed: { _web: { color: theme.colors.foreground } },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
    ...groupHoverStyle(ROW_HOVER_GROUP, { color: theme.colors.foreground }),
  },
  textHovered: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
  },
}));
