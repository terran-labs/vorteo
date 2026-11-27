import { useOpenNewWorkspace } from "@/hooks/use-open-new-workspace";
import { router, usePathname } from "expo-router";
import { CalendarClock, History, Plus, Search } from "lucide-react-native";
import { memo, useCallback, useMemo, useRef, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { sidebarContainerRowStyles } from "@/components/sidebar/container-row";
import { sidebarIndentStyle } from "@/components/sidebar/indent";
import { SidebarDashboardIcon, SidebarLeadingSlot } from "@/components/sidebar/leading-slot";
import { useSidebarRowDensity } from "@/components/sidebar/use-sidebar-row-density";
import { hoverStyle, rowSurface } from "@/styles/hover";
import { useVortonTouch } from "@/vorton-touch";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { buildSchedulesRoute, buildSessionsRoute } from "@/utils/host-routes";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
}

interface SidebarNavRowsProps extends SidebarNavRowProps {
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
  /** Sits to the right of the first row, which shrinks to make room. */
  firstRowTrailing?: ReactNode;
}

/**
 * Global dashboard navigation and the user's configured header items.
 */
export function SidebarNavRows({ style, onBeforeNavigate, firstRowTrailing }: SidebarNavRowsProps) {
  const { items } = useSidebarNavItems("header");

  const visibleItems = useMemo(
    () => items.filter((item) => item.visible && !(item.kind === "builtin")),
    [items],
  );
  const groupRef = useRef<View | null>(null);

  const rows = visibleItems.map((item) => {
    if (item.kind === "plugin") {
      return (
        <PluginSidebarItem
          key={item.key}
          group={item.group}
          section="header"
          fallbackAnchorRef={groupRef}
          onBeforeNavigate={onBeforeNavigate}
        />
      );
    }
    const Row = BUILTIN_ROWS[item.id];
    return <Row key={item.key} onBeforeNavigate={onBeforeNavigate} />;
  });
  rows.push(<DashboardSidebarRow key="dashboard" onBeforeNavigate={onBeforeNavigate} />);
  const [firstRow, ...restRows] = rows;

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {firstRowTrailing ? (
        <View style={styles.firstRow}>
          <View style={styles.firstRowItem}>{firstRow}</View>
          {firstRowTrailing}
        </View>
      ) : (
        firstRow
      )}
      {restRows}
    </View>
  );
}

/**
 * The Dashboard row reads like the Pinned and project rows below it: the folder row's geometry,
 * leading slot, calm title and icon, and hover, pressed and selected fills, so its icon and title
 * sit on the same rails inside a project focus too.
 */
function DashboardSidebarRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const selected = usePathname() === "/dashboard";
  const density = useSidebarRowDensity();
  const touch = useVortonTouch();
  const navigate = useCallback(() => {
    onBeforeNavigate?.();
    router.navigate("/dashboard");
  }, [onBeforeNavigate]);
  const rowStyle = useMemo(
    () => [
      sidebarContainerRowStyles.row,
      density,
      sidebarIndentStyle(0),
      selected ? styles.dashboardSelected : !touch && styles.dashboardHoverable,
    ],
    [density, touch, selected],
  );
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel="Dashboard"
      accessibilityState={selected ? DASHBOARD_SELECTED : undefined}
      onPress={navigate}
      style={rowStyle}
      highlightStyle={sidebarContainerRowStyles.rowPressed}
      testID="sidebar-dashboard"
    >
      <SidebarLeadingSlot chevron={null}>{dashboardIcon}</SidebarLeadingSlot>
      <Text
        style={[
          sidebarContainerRowStyles.title,
          selected ? styles.dashboardSelectedTitle : sidebarContainerRowStyles.calmTitle,
        ]}
        numberOfLines={1}
      >
        Dashboard
      </Text>
    </PressHighlight>
  );
}

const DASHBOARD_SELECTED = { selected: true } as const;
const dashboardIcon = <SidebarDashboardIcon calm cssHover />;

const SidebarNewWorkspaceRow = memo(function SidebarNewWorkspaceRow({
  onBeforeNavigate,
}: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const handlePress = useOpenNewWorkspace(onBeforeNavigate);

  return (
    <SidebarHeaderRow
      icon={Plus}
      label={t(builtinSidebarNavLabelKey("new-workspace"))}
      onPress={handlePress}
      testID="sidebar-global-new-workspace"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
});

function SidebarHistoryRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={History}
      label={t(builtinSidebarNavLabelKey("history"))}
      onPress={handlePress}
      isActive={pathname.includes("/sessions")}
      testID="sidebar-sessions"
      variant="compact"
    />
  );
}

function SidebarSearchRow() {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    setCommandCenterOpen(true);
  }, [setCommandCenterOpen]);

  return (
    <SidebarHeaderRow
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={CalendarClock}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
      variant="compact"
    />
  );
}

const BUILTIN_ROWS: Record<BuiltinSidebarNavId, ComponentType<SidebarNavRowProps>> = {
  "new-workspace": SidebarNewWorkspaceRow,
  history: SidebarHistoryRow,
  search: SidebarSearchRow,
  schedules: SidebarSchedulesRow,
};

const styles = StyleSheet.create((theme) => ({
  dashboardHoverable: hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover }),
  dashboardSelected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
    ...rowSurface(theme.colors.surfaceSidebarSelected),
  },
  dashboardSelectedTitle: { color: theme.colors.foreground },
  firstRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  firstRowItem: {
    flex: 1,
    minWidth: 0,
  },
}));
