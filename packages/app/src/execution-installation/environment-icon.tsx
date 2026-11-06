import { Box, Monitor, KeyRound } from "lucide-react-native";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { findInstallationEnvironment, readExecutionInstallation } from "./policy";
import { useSidebarRowTone } from "@/components/sidebar/row-tone";

const ThemedBox = withUnistyles(Box);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedKey = withUnistyles(KeyRound);
const neutral = (theme: Theme) => ({ color: theme.colors.foreground });
const subdued = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

export function ExecutionEnvironmentIcon({
  serverId,
  hostOnly = false,
  muted = false,
  columnWidth,
}: {
  serverId: string | null;
  hostOnly?: boolean;
  muted?: boolean;
  /** Centers the icon in a fixed-width column, so it lines up with the icons beside it. */
  columnWidth?: number;
}) {
  // Inside a sidebar row the icon takes the row's tone, like the lock and schedule marks beside it.
  const tone = useSidebarRowTone();
  const environment = serverId
    ? findInstallationEnvironment(readExecutionInstallation(), serverId)
    : null;
  if (!environment || (hostOnly && environment.kind !== "host")) return null;
  const size = ICON_SIZE.sm;
  const icon = environmentGlyph(environment.kind, size, muted || tone === "calm");
  return columnWidth ? <View style={[styles.column, { width: columnWidth }]}>{icon}</View> : icon;
}

function environmentGlyph(kind: string, size: number, muted: boolean) {
  if (kind === "container")
    return (
      <View
        style={styles.monitor}
        testID="execution-environment-container-icon"
        accessibilityLabel="Runs in dev container"
      >
        <ThemedBox size={size} uniProps={muted ? subdued : neutral} />
      </View>
    );
  return (
    <View
      style={styles.monitor}
      testID="execution-environment-host-icon"
      accessibilityLabel="Runs on host"
    >
      <ThemedMonitor size={size} uniProps={muted ? subdued : neutral} />
      <View style={styles.key}>
        <ThemedKey size={size / 2} uniProps={muted ? subdued : neutral} />
      </View>
    </View>
  );
}

export function useHasExecutionEnvironment(serverId: string | null) {
  return Boolean(serverId && findInstallationEnvironment(readExecutionInstallation(), serverId));
}

const styles = StyleSheet.create((theme) => ({
  column: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  monitor: {
    width: theme.iconSize.sm + theme.spacing[1],
    height: theme.iconSize.sm,
    flexShrink: 0,
  },
  key: {
    position: "absolute",
    right: 0,
    bottom: 0,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
  },
}));
