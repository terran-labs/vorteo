import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, type PressableStateCallbackType } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { hoverStyle } from "@/styles/hover";
import {
  SidebarPopoverRoot,
  SidebarPopoverSurface,
  useSidebarPopoverAnchor,
} from "@/components/sidebar/sidebar-popover";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useUsageHostId } from "@/usage/hosts";
import { useOpenUsageScreen } from "@/usage/sidebar-item";
import { quotaAccounts, type QuotaAccount } from "./global-quota";
import { QuotaAccountList } from "./quota-account-list";
import { QuotaFooter } from "./quota-footer";
import { quotaCellLayout, quotaCellSeries, quotaChartWidth } from "./quota-timeline";
import { QuotaCells, quotaCellsLabel } from "./quota-timelines";
import type { ProviderUsageView } from "./types";
import { useProviderUsage } from "./use-provider-usage";
import { FLOATING_PANEL_CONTROL_HEIGHT, FLOATING_PANEL_RADIUS } from "@/styles/floating-panel";

// Hover is browser-owned CSS so it clears when the sidebar reflows under a resting cursor.
function triggerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.trigger, styles.triggerHoverable, pressed && styles.triggerHovered];
}

/**
 * The right side of the sidebar's identity row: each account's week as a small chart, fitted to
 * the room the row leaves. Pressing it opens the quotas, with each account's windows, balances
 * and actions.
 */
export function SidebarFooterQuota({
  rowWidth,
  identityWidth,
}: {
  rowWidth: number;
  identityWidth: number;
}) {
  const serverId = useUsageHostId();
  // Poll for display only while the meter is on screen: its sidebar open and the app visible.
  // The daemon logs usage history on its own schedule either way.
  const panelActive = useRetainedPanelActive();
  const appVisible = useAppVisible();
  const shown = panelActive && appVisible;
  const { view } = useProviderUsage(serverId, { enabled: shown, pollUsage: shown });
  // Readings refresh every minute, so minute-precision countdowns only need the render time.
  const now = useMemo(() => (view.kind === "ready" ? Date.now() : 0), [view]);
  const accounts = useMemo(() => quotaAccounts(view, now), [view, now]);
  const series = useMemo(() => quotaCellSeries(accounts, now), [accounts, now]);
  // One measurement drives everything: the row's width and the name block's steady width. Two
  // live measurements would update on different frames while the sidebar is dragged and make the
  // chart jump between sizes.
  const room = rowWidth - identityWidth - MIN_OPEN_SPACE - TRIGGER_PADDING * 2;
  const layout = useMemo(
    () => quotaCellLayout(series, quotaChartWidth(series, rowWidth, room)),
    [series, rowWidth, room],
  );
  const [open, setOpen] = useState(false);
  if (accounts.length === 0) return null;
  return (
    <SidebarPopoverRoot open={open} onOpenChange={setOpen}>
      <FooterQuotaTrigger
        label={quotaCellsLabel(series) || `${accounts.length} accounts`}
        onOpen={setOpen}
      >
        <QuotaCells cells={layout.cells} cellWidth={layout.cellWidth} />
        {layout.overflow > 0 ? (
          <Text style={styles.overflow} testID="sidebar-footer-quota-overflow">
            +{layout.overflow}
          </Text>
        ) : null}
      </FooterQuotaTrigger>
      <FooterQuotaPopover
        accounts={accounts}
        serverId={serverId}
        view={view}
        now={now}
        onClose={setOpen}
      />
    </SidebarPopoverRoot>
  );
}

function FooterQuotaTrigger({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  const { anchorTo } = useSidebarPopoverAnchor("SidebarFooterQuota");
  const press = useCallback(() => onOpen(true), [onOpen]);
  return (
    <PressHighlight
      ref={anchorTo}
      accessibilityRole="button"
      accessibilityLabel={`Quotas. ${label}`}
      onPress={press}
      style={triggerStyle}
      testID="sidebar-footer-quota"
    >
      {children}
    </PressHighlight>
  );
}

function FooterQuotaPopover({
  accounts,
  serverId,
  view,
  now,
  onClose,
}: {
  accounts: readonly QuotaAccount[];
  serverId: string | null;
  view: ProviderUsageView;
  now: number;
  onClose: (open: boolean) => void;
}) {
  const openUsageScreen = useOpenUsageScreen();
  // Usage opens over the sidebar; a popover left open keeps its backdrop over Usage's controls.
  const openUsage = useCallback(() => {
    onClose(false);
    openUsageScreen();
  }, [onClose, openUsageScreen]);
  return (
    <SidebarPopoverSurface
      section="footer"
      title={accounts.length === 1 ? "Quota" : "Quotas"}
      testID="sidebar-footer-quota-popover"
    >
      <QuotaAccountList accounts={accounts} serverId={serverId} view={view} now={now} />
      <QuotaFooter view={view} onOpenUsage={openUsage} />
    </SidebarPopoverSurface>
  );
}

/** Inner room between the highlight's edge and the cells, as on the identity button. */
const TRIGGER_PADDING = 12;
/** The least open space kept between the installation name and the chart. */
const MIN_OPEN_SPACE = 12;

const styles = StyleSheet.create((theme) => ({
  // The toolbar buttons' height and radius, so the highlight nests inside the card's corner.
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: FLOATING_PANEL_CONTROL_HEIGHT,
    borderRadius: FLOATING_PANEL_RADIUS,
    paddingHorizontal: TRIGGER_PADDING,
    paddingVertical: theme.spacing[1],
  },
  overflow: { fontSize: theme.fontSize.sm - 2, color: theme.colors.foregroundMuted },
  triggerHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  triggerHoverable: hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover }),
}));
