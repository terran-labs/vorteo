import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View, Pressable, StyleSheet } from "react-native";
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
  reason?: string;
  onAction: (action: SystemAction) => void;
  /** Caller supplies the overflow menu containing Restart…. */
  restartMenu?: ReactNode;
  details?: ReactNode;
}
function EnvironmentRow({ row }: { row: SystemEnvironmentRow }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const act = useCallback(() => {
    if (row.action) row.onAction(row.action);
  }, [row]);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View>
      <View style={styles.row}>
        <View style={styles.description}>
          <Text>{row.name}</Text>
          <Text style={styles.reason} numberOfLines={1} accessibilityLabel={row.reason}>
            {row.reason ?? ""}
          </Text>
        </View>
        <Text accessibilityRole="text">{labels[row.status]}</Text>
        <View style={styles.action}>
          {row.action ? <Button onPress={act}>{row.action.label}</Button> : null}
        </View>
        <View style={styles.menu}>{row.restartMenu}</View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        onPress={toggle}
        style={styles.details}
      >
        <Text>Details</Text>
      </Pressable>
      {expanded ? row.details : null}
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
  row: { height: 64, flexDirection: "row", alignItems: "center", gap: 12 },
  description: { flex: 1, minWidth: 0 },
  reason: { height: 20 },
  action: { width: 240 },
  menu: { width: 40 },
  details: { height: 40, justifyContent: "center" },
  services: { height: 48, flexDirection: "row", alignItems: "center", gap: 12 },
});
