import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View, Pressable, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScrollView } from "@/components/ui/scroll-view";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { isWeb } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import type { SystemAction, SystemStatus } from "./system-status-model";

const labels: Record<SystemStatus, string> = {
  healthy: "Healthy",
  updating: "Updating",
  attention: "Needs attention",
};
const badgeVariants: Record<SystemStatus, StatusBadgeVariant> = {
  healthy: "success",
  updating: "muted",
  attention: "warning",
};
export interface SystemEnvironmentRow {
  name: "Host" | "Dev";
  status: SystemStatus;
  action: SystemAction | null;
  /** A confirmed request stays visible as a disabled control until it finishes. */
  pendingAction?: SystemAction;
  disabled?: boolean;
  reason?: string;
  onAction: (action: SystemAction) => void;
  /** Caller supplies the overflow menu containing Restart…. */
  restartMenu?: ReactNode;
  details?: ReactNode;
  /** Reveal a linked review once; subsequent polls must respect manual collapse. */
  detailsRequestId?: string | null;
}
function EnvironmentRow({ row, first }: { row: SystemEnvironmentRow; first: boolean }) {
  // A poll can drop the action, which unwraps a narrow row; keep its tallest height so the
  // sections below never jump.
  const [rowHeight, setRowHeight] = useState(0);
  const retainRowHeight = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setRowHeight((previous) => Math.max(previous, height));
  }, []);
  const rowStyle = useMemo(
    () => [styles.row, !first && settingsStyles.rowBorder, { minHeight: rowHeight }],
    [first, rowHeight],
  );
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (row.detailsRequestId) setExpanded(true);
  }, [row.detailsRequestId]);
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const act = useCallback(() => {
    if (row.action) row.onAction(row.action);
  }, [row]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const displayedAction = row.action ?? row.pendingAction;
  // React Native Web drops `accessibilityState.expanded`; pass it as ARIA too.
  const webExpanded = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  return (
    <View>
      {/* One line per environment: name, status, its action, the menu and Details. */}
      <View style={rowStyle} onLayout={retainRowHeight}>
        <View style={styles.line}>
          <Text style={settingsStyles.rowTitle}>{row.name}</Text>
          <StatusBadge label={labels[row.status]} variant={badgeVariants[row.status]} />
          <View style={styles.spacer} />
          {displayedAction ? (
            <Button
              onPress={act}
              disabled={row.disabled || !row.action}
              testID={
                displayedAction.kind === "update"
                  ? "host-page-update-button"
                  : `system-primary-${row.name.toLowerCase()}`
              }
            >
              {displayedAction.label}
            </Button>
          ) : null}
          {row.restartMenu ? <View style={styles.menu}>{row.restartMenu}</View> : null}
          <Pressable
            {...webExpanded}
            accessibilityRole="button"
            accessibilityState={accessibilityState}
            onPress={toggle}
            style={styles.details}
          >
            <Text style={styles.detailsText}>{`${row.name} Details`}</Text>
          </Pressable>
        </View>
        {row.reason ? <Text style={styles.reason}>{row.reason}</Text> : null}
      </View>
      {expanded ? <ScrollView style={styles.detailsViewport}>{row.details}</ScrollView> : null}
    </View>
  );
}
export function SystemView({
  environments,
  services,
  servicesReason,
}: {
  environments: readonly SystemEnvironmentRow[];
  services?: SystemStatus | null;
  servicesReason?: string;
}) {
  // Zero until services first report, so a card without them reserves no empty row; once shown,
  // the slot keeps its tallest height so readiness polling cannot move the next section.
  const [servicesHeight, setServicesHeight] = useState(0);
  const retainServicesHeight = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setServicesHeight((previous) => Math.max(previous, height));
  }, []);
  const servicesStyle = useMemo(
    () => [
      styles.services,
      environments.length > 0 && settingsStyles.rowBorder,
      { minHeight: servicesHeight },
    ],
    [environments.length, servicesHeight],
  );
  return (
    <View style={settingsStyles.card}>
      {environments.map((row, index) => (
        <EnvironmentRow key={row.name} row={row} first={index === 0} />
      ))}
      {services || servicesHeight > 0 ? (
        <View style={servicesStyle} onLayout={retainServicesHeight}>
          {services ? (
            <>
              <Text style={[settingsStyles.rowTitle, styles.servicesTitle]}>System services</Text>
              <StatusBadge label={labels[services]} variant={badgeVariants[services]} />
              {servicesReason ? (
                <Text style={[styles.reason, styles.servicesReason]}>{servicesReason}</Text>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// Content drives height so status explanations remain readable at phone and tablet widths.
const styles = StyleSheet.create((theme) => ({
  row: {
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  // Wraps on narrow panes rather than clipping the action or menu.
  line: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    minHeight: 44,
    gap: theme.spacing[2],
  },
  spacer: { flexGrow: 1 },
  servicesTitle: { flexGrow: 1, flexShrink: 1 },
  servicesReason: { width: "100%" },
  reason: { lineHeight: 20, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  // The overflow trigger sizes to its label instead of truncating to an ellipsis.
  menu: { minWidth: 72, flexShrink: 0 },
  detailsViewport: { height: 560 },
  details: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.spacing[2] },
  detailsText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  services: {
    minHeight: 44,
    paddingVertical: theme.spacing[3],
    flexWrap: "wrap",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
}));
