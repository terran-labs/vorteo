import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View, Pressable, useWindowDimensions } from "react-native";
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
  const { width } = useWindowDimensions();
  const compact = width < 1100;
  const rowStyle = useMemo(
    () => [styles.row, compact && styles.compactRow, !first && settingsStyles.rowBorder],
    [compact, first],
  );
  const descriptionStyle = useMemo(
    () => [styles.description, compact && styles.compactDescription],
    [compact],
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
  return (
    <View>
      <View style={rowStyle}>
        <View style={descriptionStyle}>
          <Text style={settingsStyles.rowTitle}>{row.name}</Text>
          <Text style={styles.reason} numberOfLines={1} accessibilityLabel={row.reason}>
            {row.reason ?? ""}
          </Text>
        </View>
        <StatusBadge label={labels[row.status]} variant={badgeVariants[row.status]} />
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
}: {
  environments: readonly SystemEnvironmentRow[];
  services?: SystemStatus | null;
}) {
  return (
    <View style={settingsStyles.card}>
      {environments.map((row, index) => (
        <EnvironmentRow key={row.name} row={row} first={index === 0} />
      ))}
      {/* Reserve this slot so readiness polling cannot move the next section. */}
      <View style={[styles.services, environments.length > 0 && settingsStyles.rowBorder]}>
        {services ? (
          <>
            <Text style={settingsStyles.rowTitle}>System services</Text>
            <StatusBadge label={labels[services]} variant={badgeVariants[services]} />
          </>
        ) : null}
      </View>
    </View>
  );
}

// Colors come from the theme so rows stay legible in light and dark; fixed heights keep
// polling from moving the sections below.
const styles = StyleSheet.create((theme) => ({
  row: {
    height: 80,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  compactRow: { height: 136, flexWrap: "wrap", alignContent: "center" },
  compactDescription: { flexBasis: "65%", flexGrow: 1 },
  description: { flex: 1, minWidth: 0 },
  reason: { height: 20, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  action: { flexGrow: 1, flexBasis: 160, maxWidth: 240 },
  // The overflow trigger sizes to its label instead of truncating to an ellipsis.
  menu: { minWidth: 72, flexShrink: 0 },
  detailsViewport: { height: 560 },
  details: { height: 40, justifyContent: "center", paddingHorizontal: theme.spacing[4] },
  detailsText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  services: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
}));
