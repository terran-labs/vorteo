import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View, Pressable, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScrollView } from "@/components/ui/scroll-view";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
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
  const rowStyle = useMemo(() => [styles.row, !first && settingsStyles.rowBorder], [first]);
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
  return (
    <View>
      <View style={rowStyle}>
        <View style={styles.environmentHeading}>
          <Text style={settingsStyles.rowTitle}>{row.name}</Text>
          <StatusBadge label={labels[row.status]} variant={badgeVariants[row.status]} />
        </View>
        {row.reason ? <Text style={styles.reason}>{row.reason}</Text> : null}
        <View style={styles.controls}>
          <View style={styles.action}>
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
          </View>
          <View style={styles.menu}>{row.restartMenu}</View>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={styles.details}
      >
        <Text style={styles.detailsText}>{`${row.name} Details`}</Text>
      </Pressable>
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
  const [servicesHeight, setServicesHeight] = useState(48);
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
      {/* Reserve this slot so readiness polling cannot move the next section. */}
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
    </View>
  );
}

// Content drives height so status explanations remain readable at phone and tablet widths.
const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 80,
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  environmentHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  // Keep the action rail's height when polling replaces an approval with running status.
  controls: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: theme.spacing[3] },
  servicesTitle: { flexGrow: 1, flexShrink: 1 },
  servicesReason: { width: "100%" },
  reason: { lineHeight: 20, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  action: { flex: 1, alignItems: "flex-start" },
  // The overflow trigger sizes to its label instead of truncating to an ellipsis.
  menu: { minWidth: 72, flexShrink: 0 },
  detailsViewport: { height: 560 },
  details: { minHeight: 44, justifyContent: "center", paddingHorizontal: theme.spacing[4] },
  detailsText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  services: {
    minHeight: 48,
    paddingVertical: theme.spacing[3],
    flexWrap: "wrap",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
}));
