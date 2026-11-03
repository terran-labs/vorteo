/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop -- These bounded form controls render with their draft; callbacks intentionally read the current draft. */
import { useState, type ReactNode } from "react";
import { Text, View, Pressable } from "react-native";
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
  onAction: (action: SystemAction) => void;
  /** Caller supplies the overflow menu containing Restart…. */
  restartMenu?: ReactNode;
  details?: ReactNode;
}
function EnvironmentRow({ row }: { row: SystemEnvironmentRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <View
        style={{
          height: 64,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Text>{row.name}</Text>
        <Text accessibilityRole="text">{labels[row.status]}</Text>
        <View style={{ flex: 1 }} />
        <View style={{ width: 240 }}>
          {row.action ? (
            <Button onPress={() => row.action && row.onAction(row.action)}>
              {row.action.label}
            </Button>
          ) : null}
        </View>
        <View style={{ width: 40 }}>{row.restartMenu}</View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ height: 40, justifyContent: "center" }}
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
      <View
        style={{
          height: 48,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
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
