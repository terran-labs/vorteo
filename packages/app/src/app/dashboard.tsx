import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import type { DashboardSample } from "@getpaseo/protocol/messages";
import { PageLayout } from "@/components/page-layout";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { toggleCard, useDashboardPreferences } from "@/screens/dashboard/preferences";

const titles: Record<string, string> = {
  workspaces: "Active workspaces",
  projects: "Active projects",
  tokens: "Reported session tokens",
  apiUsd: "API-equivalent spend",
  reporting: "Threads reporting token usage",
  subscribers: "Newsletter subscribers",
  synPlayers: "Syn3h active players today",
  synSessions: "Syn3h sessions today",
  synMinutes: "Syn3h active minutes today",
  synCrashes: "Syn3h crashes today",
  synReturning: "Returning Syn3h players today",
  synD7: "Day-seven return rate (%) · today so far",
  synCohort: "Players first seen seven days ago",
  synPlayMinutes: "Syn3h play minutes today",
  synRejoins: "Syn3h rejoins today",
  synRoomFull: "Syn3h full-room events today",
  synPeak: "Syn3h peak concurrent players today",
};
function metricTitle(key: string) {
  if (titles[key]) return titles[key];
  const [kind, repo] = key.split(":");
  const labels: Record<string, string> = {
    releases: "GitHub release records",
    closed: "Factory closures today",
    arrivals: "Factory arrivals today",
    oldest: "Oldest open Factory ticket (days)",
    open: "Open Factory tickets",
  };
  return labels[kind!] && repo ? labels[kind!] + " · " + repo : key;
}
function metricValue(key: string, value: number) {
  return key === "apiUsd"
    ? value.toLocaleString(undefined, { style: "currency", currency: "USD" })
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function Metric({ id, samples }: { id: string; samples: DashboardSample[] }) {
  const recent = samples;
  const values = recent.map((sample) => sample.values[id]);
  const max = Math.max(0, ...values.map((n) => n ?? 0));
  const current = values.at(-1);
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{metricTitle(id)}</Text>
      <Text style={styles.value}>
        {current === undefined ? "Unavailable" : metricValue(id, current)}
      </Text>
      {recent.length > 1 && (
        <View style={styles.chart} accessibilityLabel={"Last " + recent.length + " observations"}>
          {recent.map((sample, index) => (
            <View
              key={sample.at}
              style={[
                styles.bar,
                {
                  height:
                    values[index] === undefined
                      ? 0
                      : Math.max(1, (32 * (values[index] ?? 0)) / (max || 1)),
                },
              ]}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const SELECTED = { selected: true };
const CHECKED = { checked: true };
const UNCHECKED = { checked: false };
function RangeButton({
  days,
  selected,
  choose,
}: {
  days: number;
  selected: boolean;
  choose: (days: number) => void;
}) {
  const onPress = useCallback(() => choose(days), [choose, days]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED : undefined}
      onPress={onPress}
    >
      <Text style={selected ? styles.action : styles.rangeLabel}>
        {days === 1 ? "24 hours" : days + " days"}
      </Text>
    </PressHighlight>
  );
}
function CardToggle({ id, serverId, visible }: { id: string; serverId: string; visible: boolean }) {
  const onPress = useCallback(() => toggleCard(serverId, id), [serverId, id]);
  return (
    <PressHighlight
      accessibilityRole="checkbox"
      accessibilityState={visible ? CHECKED : UNCHECKED}
      style={styles.card}
      onPress={onPress}
    >
      <Text style={styles.label}>{metricTitle(id)}</Text>
      <Text style={styles.action}>{visible ? "Visible" : "Hidden"}</Text>
    </PressHighlight>
  );
}
function leaveDashboard() {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}
function HostMetrics({ serverId, label }: { serverId: string; label: string }) {
  const [days, setDays] = useState(1);
  const [editing, setEditing] = useState(false);
  const toggleEditing = useCallback(() => setEditing((current) => !current), []);
  const hidden = useDashboardPreferences((state) => state.hidden[serverId]);
  const snapshot = useHostRuntimeSnapshot(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.dashboardMetrics,
  );
  const count = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return session?.hasHydratedWorkspaces ? session.workspaces.size : null;
  });
  const client = snapshot?.client;
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["dashboard-history", serverId],
    enabled: Boolean(supported && client && snapshot?.connectionStatus === "online"),
    staleTimeMs: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error("Reconnect to load dashboard data.");
      const result = await client.getDashboardMetrics();
      if (result.error) throw new Error(result.error);
      return result.samples;
    },
  });
  const samples = query.data ?? [];
  const latest = samples.at(-1);
  const windowStart = latest ? Date.parse(latest.at) - days * 86_400_000 : 0;
  const inRange = samples.filter((point) => Date.parse(point.at) > windowStart);
  // Longer windows show the final observation of each UTC day.
  const points =
    days === 1
      ? inRange
      : [...new Map(inRange.map((point) => [point.at.slice(0, 10), point])).values()];
  const keys = [...new Set(inRange.flatMap((sample) => Object.keys(sample.values)))];
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.heading}>{label}</Text>
        {latest && (
          <PressHighlight accessibilityRole="button" onPress={toggleEditing}>
            <Text style={styles.action}>{editing ? "Done" : "Customize"}</Text>
          </PressHighlight>
        )}
      </View>
      {latest ? (
        <Text style={styles.label}>
          Hourly observations · Latest {new Date(latest.at).toLocaleString()}
        </Text>
      ) : (
        <Text style={styles.label}>
          {count === null
            ? "Workspace count unavailable"
            : count.toLocaleString() + " workspaces in this session"}{" "}
          · {supported ? "Waiting for first observation" : "Hourly collection unavailable"}
        </Text>
      )}
      {latest && (
        <View style={styles.range}>
          {[1, 7, 30, 90].map((span) => (
            <RangeButton key={span} days={span} selected={days === span} choose={setDays} />
          ))}
        </View>
      )}
      {query.isError && <Text style={styles.label}>Could not refresh dashboard data.</Text>}
      {latest?.unavailable.map((source) => (
        <Text key={source} style={styles.label}>
          {source}
        </Text>
      ))}
      <View style={styles.grid}>
        {editing
          ? keys.map((id) => (
              <CardToggle key={id} id={id} serverId={serverId} visible={!hidden?.includes(id)} />
            ))
          : keys
              .filter((id) => !hidden?.includes(id))
              .map((id) => <Metric key={id} id={id} samples={points} />)}
      </View>
    </View>
  );
}
function Dashboard() {
  const hosts = useHosts();
  return (
    <PageLayout title="Dashboard" wide onBack={leaveDashboard}>
      {hosts.length === 0 && (
        <Text style={styles.label}>Connect a host to view its dashboard.</Text>
      )}
      {hosts.map((host) => (
        <HostMetrics key={host.serverId} serverId={host.serverId} label={host.label} />
      ))}
    </PageLayout>
  );
}
export default function DashboardRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <Dashboard />
    </HostRouteBootstrapBoundary>
  );
}
const styles = StyleSheet.create((theme) => ({
  range: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  rangeLabel: { color: theme.colors.foregroundMuted, padding: theme.spacing[2] },
  section: { gap: theme.spacing[3], paddingBottom: theme.spacing[6] },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  card: {
    flexGrow: 1,
    flexBasis: 180,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: 8,
  },
  heading: { color: theme.colors.foreground, fontSize: theme.fontSize.lg },
  value: { color: theme.colors.foreground, fontSize: 28, fontVariant: ["tabular-nums"] },
  action: { color: theme.colors.foreground, padding: theme.spacing[2] },
  label: { color: theme.colors.foregroundMuted },
  chart: { height: 32, alignItems: "flex-end", flexDirection: "row", gap: 2 },
  bar: { flex: 1, backgroundColor: theme.colors.foregroundMuted },
}));
