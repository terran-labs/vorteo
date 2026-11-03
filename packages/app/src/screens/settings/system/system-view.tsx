import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View, Pressable, StyleSheet, ScrollView, useWindowDimensions } from "react-native";
import { Button } from "@/components/ui/button";
import type { SystemAction, SystemStatus } from "./system-status-model";

const labels: Record<SystemStatus, string> = {
  healthy: "Healthy",
  updating: "Updating",
  attention: "Needs attention",
};
export interface SystemEnvironmentRow {
  name: "Host" | "Dev";
  status: SystemStatus;
  action: SystemAction | null;
  disabled?: boolean;
  reason?: string;
  onAction: (action: SystemAction) => void;
  /** Caller supplies the overflow menu containing Restart…. */
  restartMenu?: ReactNode;
  details?: ReactNode;
}
function EnvironmentRow({ row }: { row: SystemEnvironmentRow }) {
  const { width } = useWindowDimensions();
  const compact = width < 1100;
  const rowStyle = useMemo(() => [styles.row, compact && styles.compactRow], [compact]);
  const descriptionStyle = useMemo(
    () => [styles.description, compact && styles.compactDescription],
    [compact],
  );
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const act = useCallback(() => {
    if (row.action) row.onAction(row.action);
  }, [row]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View>
      <View style={rowStyle}>
        <View style={descriptionStyle}>
          <Text>{row.name}</Text>
          <Text style={styles.reason} numberOfLines={1} accessibilityLabel={row.reason}>
            {row.reason ?? ""}
          </Text>
        </View>
        <Text accessibilityRole="text">{labels[row.status]}</Text>
        <View style={styles.action}>
          {row.action ? (
            <Button
              onPress={act}
              disabled={row.disabled}
              testID={
                row.action.kind === "update"
                  ? "host-page-update-button"
                  : `system-primary-${row.name.toLowerCase()}`
              }
            >
              {row.action.label}
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
        <Text>{`${row.name} Details`}</Text>
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
    <View>
      {environments.map((row) => (
        <EnvironmentRow key={row.name} row={row} />
      ))}
      {/* Reserve this slot so readiness polling cannot move the next section. */}
      <View style={styles.services}>
        {services ? (
          <>
            <Text>System services</Text>
            <Text>{labels[services]}</Text>
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { height: 80, flexDirection: "row", alignItems: "center", gap: 12 },
  compactRow: { height: 136, flexWrap: "wrap", alignContent: "center" },
  compactDescription: { flexBasis: "65%", flexGrow: 1 },
  description: { flex: 1, minWidth: 0 },
  reason: { height: 20 },
  action: { flexGrow: 1, flexBasis: 160, maxWidth: 240 },
  menu: { width: 72 },
  detailsViewport: { height: 560 },
  details: { height: 40, justifyContent: "center" },
  services: { height: 48, flexDirection: "row", alignItems: "center", gap: 12 },
});
