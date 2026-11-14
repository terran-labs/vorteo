import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type RefObject,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Blocks } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isWeb } from "@/constants/platform";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import {
  BUILTIN_SIDEBAR_ITEM_IDS,
  type PluginSidebarNavItem,
  type SidebarSection,
} from "@/sidebar-nav/model";
import { pluginIconComponent } from "@/plugins/icons";
import { ResetGroupButton } from "@/screens/settings/appearance/reset-group-button";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);

const moveUpIcon = <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

/** Plugin items register no icon, so they share this one; a legacy `addSidebarItem` keeps its own. */
const PLUGIN_ICON = Blocks;

type NavIconComponent = ComponentType<{ size: number; color: string }>;

function NavIcon({ Icon, color = "" }: { Icon: NavIconComponent; color?: string }) {
  return <Icon size={ICON_SIZE.md} color={color} />;
}

const ThemedNavIcon = withUnistyles(NavIcon);

function navItemIcon(item: PluginSidebarNavItem): NavIconComponent {
  return item.group.kind === "legacy" ? pluginIconComponent(item.group.icon) : PLUGIN_ICON;
}

interface SidebarNavRowProps {
  item: PluginSidebarNavItem;
  index: number;
  count: number;
  onMove: (key: string, direction: "up" | "down") => void;
  onSetVisible: (key: string, visible: boolean) => void;
}

function focusWebElement(ref: RefObject<View | null>) {
  // On web a View ref is its DOM element.
  if (isWeb) (ref.current as unknown as HTMLElement | null)?.focus();
}

function SidebarNavRow({
  item,
  index,
  count,
  onMove,
  onSetVisible,
}: SidebarNavRowProps): ReactElement {
  const label = item.group.title;
  const isFirst = index === 0;
  const isLast = index === count - 1;
  const upButton = useRef<View>(null);
  const downButton = useRef<View>(null);
  // Which arrow keeps focus after a move. Reaching an end disables the pressed arrow, and
  // reordering can move this row's DOM node, so focus is placed again once the row lands.
  const pendingFocus = useRef<"up" | "down" | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target) focusWebElement(target === "up" ? upButton : downButton);
  }, [index]);

  const handleMoveUp = useCallback(() => {
    pendingFocus.current = index - 1 === 0 ? "down" : "up";
    onMove(item.key, "up");
  }, [index, item.key, onMove]);
  const handleMoveDown = useCallback(() => {
    pendingFocus.current = index + 1 === count - 1 ? "up" : "down";
    onMove(item.key, "down");
  }, [count, index, item.key, onMove]);
  const handleVisibleChange = useCallback(
    (visible: boolean) => onSetVisible(item.key, visible),
    [item.key, onSetVisible],
  );

  const rowStyle = useMemo(
    () => [settingsStyles.row, isFirst ? null : settingsStyles.rowBorder, styles.row],
    [isFirst],
  );

  return (
    <View style={rowStyle} testID={`sidebar-nav-item-${item.key}`}>
      <View style={styles.rowMain}>
        <ThemedNavIcon Icon={navItemIcon(item)} uniProps={mutedColorMapping} />
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Button
          ref={upButton}
          variant="ghost"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={isFirst}
          accessibilityLabel={`Move ${label} up`}
          testID={`sidebar-nav-move-up-${item.key}`}
        />
        <Button
          ref={downButton}
          variant="ghost"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={isLast}
          accessibilityLabel={`Move ${label} down`}
          testID={`sidebar-nav-move-down-${item.key}`}
        />
        <Switch
          value={item.visible}
          onValueChange={handleVisibleChange}
          accessibilityLabel={`Show ${label}`}
          testID={`sidebar-nav-toggle-${item.key}`}
        />
      </View>
    </View>
  );
}

const SECTION_INFO = {
  header:
    "Plugin items at the top of the sidebar. History, Schedules and Search stay in the toolbar.",
  footer: "Plugin rows at the bottom of the sidebar. Usage stays beside the installation name.",
} as const satisfies Record<SidebarSection, string>;

const SECTION_TITLE_KEYS = {
  header: "settings.appearance.sidebar.header.title",
  footer: "settings.appearance.sidebar.footer.title",
} as const satisfies Record<SidebarSection, string>;

/**
 * Only plugin items: the built-in toolbar, Add project and the usage meter are fixed. Excluding
 * the built-ins also keeps Move up and Move down from swapping with an entry nobody can see.
 */
function usePluginSidebarItems(section: SidebarSection) {
  const { items, setVisible, move } = useSidebarNavItems(
    section,
    BUILTIN_SIDEBAR_ITEM_IDS[section],
  );
  const pluginItems = useMemo(
    () => items.filter((item): item is PluginSidebarNavItem => item.kind === "plugin"),
    [items],
  );
  return { items: pluginItems, setVisible, move };
}

function SidebarItemsCard({
  section,
  items,
  onMove,
  onSetVisible,
  trailing,
}: {
  section: SidebarSection;
  items: readonly PluginSidebarNavItem[];
  trailing?: ReactElement;
  onMove: (key: string, direction: "up" | "down") => void;
  onSetVisible: (key: string, visible: boolean) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const [status, setStatus] = useState("");
  // Announces where the item landed; the arrows alone give no sign of the new order.
  const move = useCallback(
    (key: string, direction: "up" | "down") => {
      const from = items.findIndex((item) => item.key === key);
      const to = direction === "up" ? from - 1 : from + 1;
      if (from !== -1 && to >= 0 && to < items.length) {
        setStatus(`${items[from].group.title} moved to position ${to + 1} of ${items.length}`);
      }
      onMove(key, direction);
    },
    [items, onMove],
  );
  if (items.length === 0) return null;
  return (
    <SettingsSection
      title={t(SECTION_TITLE_KEYS[section])}
      info={SECTION_INFO[section]}
      trailing={trailing}
      testID={`sidebar-nav-section-${section}`}
    >
      <View style={settingsStyles.card}>
        {items.map((item, index) => (
          <SidebarNavRow
            key={item.key}
            item={item}
            index={index}
            count={items.length}
            onMove={move}
            onSetVisible={onSetVisible}
          />
        ))}
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.visuallyHidden}>
        {status}
      </Text>
    </SettingsSection>
  );
}

/**
 * Settings > Sidebar: show, hide and reorder the items plugins add to the sidebar. Built-in
 * navigation is not listed because the toolbar always shows it; earlier History, Schedules and
 * Usage switches stored values the sidebar never read. Old stored entries for them are ignored.
 */
export function SidebarNavSection(): ReactElement {
  const header = usePluginSidebarItems("header");
  const footer = usePluginSidebarItems("footer");
  if (header.items.length === 0 && footer.items.length === 0) {
    return (
      <SettingsSection title="Plugin items" testID="sidebar-nav-section-empty">
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>
              No plugin adds sidebar items. Items that plugins add can be hidden or reordered here.
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }
  // One Reset covers both cards, so it sits on whichever card comes first.
  const reset = SIDEBAR_RESET;
  return (
    <>
      <SidebarItemsCard
        section="header"
        items={header.items}
        onMove={header.move}
        onSetVisible={header.setVisible}
        trailing={reset}
      />
      <SidebarItemsCard
        section="footer"
        items={footer.items}
        onMove={footer.move}
        onSetVisible={footer.setVisible}
        trailing={header.items.length === 0 ? reset : undefined}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[2],
  },
  rowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  visuallyHidden: { position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0 },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));

const SIDEBAR_RESET = <ResetGroupButton group="sidebar" />;
