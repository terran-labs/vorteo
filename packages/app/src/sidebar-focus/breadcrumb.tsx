import { Fragment, useCallback, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight, House } from "lucide-react-native";
import { densityIconBox } from "@/styles/density";
import { useSidebarRowDensity } from "@/components/sidebar/use-sidebar-row-density";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { SIDEBAR_ROW_INSET } from "@/components/sidebar/indent";
import type { Theme } from "@/styles/theme";
import { groupHoverStyle, hoverGroup, hoverStyle, revealOnGroupHover } from "@/styles/hover";
import { LIST_ROW_TOUCH_ACTION_SIZE } from "@/styles/list-row-metrics";
import { useVortonTouch } from "@/vorton-touch";
import { useSidebarFocus } from "./context";
import type { SidebarFocusCrumb, SidebarFocusTarget } from "./model";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedHouse = withUnistyles(House);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// On web the home glyph strokes with its slot's CSS color, so the crumb's group hover recolors it.
const homeIconMapping = isWeb ? () => ({ color: "currentColor" }) : mutedColorMapping;

/** A crumb is its label's and glyph's hover group. */
const CRUMB_HOVER_GROUP = "sidebar-crumb";
/** The breadcrumb row reveals its trailing actions while hovered or focused. */
const BREADCRUMB_HOVER_GROUP = "sidebar-breadcrumb";

/**
 * Ghost-button chrome: a quiet fill on hover and press, never an underline. Hover is CSS, so it
 * clears when focusing a crumb moves the breadcrumb out from under a resting cursor.
 */
function crumbStyle({ pressed }: PressableStateCallbackType) {
  return [styles.crumbButton, pressed && styles.crumbButtonPressed];
}

function Crumb({
  crumb,
  onSelect,
}: {
  crumb: SidebarFocusCrumb;
  onSelect: (target: SidebarFocusTarget | null) => void;
}) {
  const touch = useVortonTouch();
  const handlePress = useCallback(() => onSelect(crumb.target), [onSelect, crumb.target]);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={crumb.label}
      onPress={handlePress}
      style={touch ? styles.touchCrumb : crumbStyle}
      testID={`sidebar-focus-crumb-${crumb.key}`}
    >
      <View style={styles.crumbRow}>
        {/* All projects leads with a home glyph in the project row's icon slot, so its
            label lands where the hidden project title was. */}
        {crumb.target === null ? (
          <View style={[styles.leadingSlot, styles.homeGlyph]}>
            <ThemedHouse size={12} uniProps={homeIconMapping} />
          </View>
        ) : null}
        <Text style={styles.crumb} numberOfLines={1}>
          {crumb.label}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The path from All projects to the focused item. Every segment but the last focuses that
 * level; All projects leaves focus. There is deliberately no back button. The focused item's
 * own row is hidden, so its actions trail the last segment: on hover with a pointer, while
 * keyboard focus is inside them, and always where rows cannot be hovered.
 */
export function SidebarFocusBreadcrumb({
  trail,
  actions,
  persistentActions,
}: {
  trail: readonly SidebarFocusCrumb[];
  /** Revealed on hover or keyboard focus with a pointer; always shown where hover is unavailable. */
  actions?: ReactNode;
  /** Always shown after the revealed actions, like the new workspace plus. */
  persistentActions?: ReactNode;
}) {
  const { t } = useTranslation();
  const controller = useSidebarFocus();
  const touch = useVortonTouch();
  const compact = useIsCompactFormFactor();
  const last = trail[trail.length - 1];
  const density = useSidebarRowDensity();

  if (!controller || !last) return null;
  const ancestors = trail.slice(0, -1);
  // Hidden actions stay mounted and reachable by Tab. CSS reveals them while the breadcrumb is
  // hovered or holds keyboard focus; layouts without hover always show them.
  const hoverUnavailable = touch || compact || isNative;
  return (
    <View
      role="navigation"
      accessibilityLabel={t("sidebar.focus.breadcrumb")}
      style={[styles.container, density]}
      testID="sidebar-focus-breadcrumb"
    >
      <View style={styles.trail}>
        {ancestors.map((crumb) => (
          <Fragment key={crumb.key}>
            <Crumb crumb={crumb} onSelect={controller.focusOn} />
            <ThemedChevronRight size={14} uniProps={mutedColorMapping} />
          </Fragment>
        ))}
        <Text
          style={styles.current}
          numberOfLines={1}
          accessibilityRole="header"
          testID="sidebar-focus-current"
        >
          {last.label}
        </Text>
      </View>
      {actions ? (
        <View
          style={[styles.actions, !hoverUnavailable && styles.actionsReveal]}
          testID="sidebar-focus-actions"
        >
          {actions}
        </View>
      ) : null}
      {persistentActions ? (
        <View style={styles.actions} testID="sidebar-focus-persistent-actions">
          {persistentActions}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The project row's geometry: the breadcrumb replaces the hidden row in place, so the rows
  // below must not move when focus changes. Keep in step with `projectRow`.
  container: {
    ...hoverGroup(BREADCRUMB_HOVER_GROUP),
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: SIDEBAR_ROW_INSET,
    paddingRight: theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  crumbRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  leadingSlot: {
    width: densityIconBox("md"),
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  trail: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[1.5],
    rowGap: theme.spacing[0.5],
  },
  crumb: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    ...groupHoverStyle(CRUMB_HOVER_GROUP, { color: theme.colors.foreground }),
  },
  homeGlyph: groupHoverStyle(
    CRUMB_HOVER_GROUP,
    { color: theme.colors.foreground },
    { color: theme.colors.foregroundMuted },
  ),
  touchCrumb: {
    minWidth: LIST_ROW_TOUCH_ACTION_SIZE,
    minHeight: LIST_ROW_TOUCH_ACTION_SIZE,
    justifyContent: "center",
  },
  // The negative margins let the hover fill reach past the label without moving it, so the
  // label stays aligned with the project title it replaces.
  crumbButton: {
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[1],
    marginHorizontal: -theme.spacing[1],
    paddingVertical: 2,
    marginVertical: -2,
    ...hoverGroup(
      CRUMB_HOVER_GROUP,
      hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover })._web,
    ),
  },
  crumbButtonPressed: { backgroundColor: theme.colors.surfaceSidebarHover },
  current: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 20,
    flexShrink: 1,
  },
  actions: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
  },
  actionsReveal: revealOnGroupHover(BREADCRUMB_HOVER_GROUP),
}));
