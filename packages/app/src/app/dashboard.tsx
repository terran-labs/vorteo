import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import type { DashboardSample } from "@getpaseo/protocol/messages";
import { PageLayout } from "@/components/page-layout";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  useHosts,
  useHostRuntimeSnapshot,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { dashboardHistoryKey, fetchAuthorizedDashboardHistory } from "@/screens/dashboard/cache";
import {
  DASHBOARD_HOUR_MS,
  getDashboardWindow,
  isDashboardIntervalMetric,
  type DashboardBucket,
} from "@/screens/dashboard/history";
import { toggleCard, useDashboardPreferences } from "@/screens/dashboard/preferences";

const titles: Record<string, string> = {
  workspaces: "Active workspaces",
  projects: "Active projects",
  tokens: "Latest reported token counts",
  apiUsd: "API-equivalent spend",
  intervalTokens: "Observed tokens since last hourly sample",
  intervalApiUsd: "Observed API-equivalent cost since last hourly sample",
  reporting: "Threads reporting token usage",
  subscribers: "Newsletter subscribers",
  newsletterEligible: "Eligible newsletter subscribers",
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
  const separator = key.indexOf(":");
  if (separator === -1) return key;
  const kind = key.slice(0, separator);
  const subject = key.slice(separator + 1);
  if (!subject) return key;
  if (kind === "newsletterSource") return "Eligible subscribers from " + subject;
  if (kind.startsWith("factory-")) {
    const stage = kind.slice("factory-".length).replaceAll("-", " ");
    return "Factory items in " + stage + " · " + subject;
  }
  const labels: Record<string, string> = {
    releases: "GitHub release records",
    closed: "Factory closures today",
    arrivals: "Factory arrivals today",
    oldest: "Oldest open Factory ticket (days)",
    open: "Open Factory tickets",
    qualifiedMerges: "Factory merges today (UTC)",
    firstAdmissions: "First Factory label admissions today (UTC)",
    oldestOpenDays: "Oldest open Factory issue (days since creation)",
    issueClosures: "Issues closed after a Factory merge today (UTC)",
  };
  return labels[kind] ? labels[kind] + " · " + subject : key;
}
function metricValue(key: string, value: number) {
  return key === "apiUsd" || key === "intervalApiUsd"
    ? value.toLocaleString(undefined, { style: "currency", currency: "USD" })
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function Metric({
  id,
  points,
  days,
  latest,
}: {
  id: string;
  points: DashboardBucket[];
  days: number;
  latest: DashboardSample | undefined;
}) {
  const daily = days > 1;
  const dailyInterval = daily && isDashboardIntervalMetric(id);
  const values = points.map(({ start, sample, intervals }) => {
    const interval = intervals?.get(id);
    return {
      start,
      observedHours: interval?.hours,
      asOf: sample?.at,
      value: dailyInterval ? interval?.sum : sample?.values[id],
    };
  });
  const max = Math.max(0, ...values.map(({ value }) => value ?? 0));
  const current = latest?.values[id];
  let chartTitle = "Hourly observations (UTC)";
  if (daily) {
    chartTitle = dailyInterval
      ? "Daily observed sums (UTC). Coverage counts hours with a reported change."
      : "Last hourly observation of each day (UTC)";
  }
  const latestCoverage = values.at(-1)?.observedHours ?? 0;
  const trend = values.map(({ start, value, observedHours, asOf }) => {
    const period = formatChartTime(start, daily);
    if (value === undefined) return period + ", gap";
    const formatted = period + ", " + metricValue(id, value);
    if (dailyInterval) return formatted + ", " + observedHours + " of 24 hours observed";
    if (daily && asOf) return formatted + ", as of " + formatChartTime(Date.parse(asOf), false);
    return formatted;
  });
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{metricTitle(id)}</Text>
      <Text style={styles.value}>
        {current === undefined ? "Unavailable" : metricValue(id, current)}
      </Text>
      {daily && <Text style={styles.label}>{chartTitle}</Text>}
      {dailyInterval && (
        <Text style={styles.label}>Latest UTC day: {latestCoverage} of 24 hours observed</Text>
      )}
      <View style={styles.chart} accessible accessibilityLabel={[chartTitle, ...trend].join(". ")}>
        {values.map(({ start, value }) => (
          <View key={start} style={styles.chartSlot}>
            {value !== undefined && (
              <View style={[styles.bar, { height: Math.max(1, (32 * value) / (max || 1)) }]} />
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

function formatChartTime(time: number, dateOnly: boolean) {
  const iso = new Date(time).toISOString();
  return dateOnly ? iso.slice(0, 10) : iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC";
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
      style={styles.control}
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
function useHostDashboard(serverId: string) {
  const snapshot = useHostRuntimeSnapshot(serverId);
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const supported = serverInfo ? serverInfo.features?.dashboardMetrics === true : undefined;
  const count = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return session?.hasHydratedWorkspaces ? session.workspaces.size : null;
  });
  const client = snapshot?.client;
  const availability = dashboardAvailability(
    snapshot?.connectionStatus,
    supported,
    Boolean(snapshot?.authFailureReason),
  );
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: [
      ...dashboardHistoryKey(serverId),
      snapshot?.authorizationGeneration,
      snapshot?.connectionEpoch,
    ],
    enabled: availability === "available" && Boolean(client),
    gcTime: Infinity,
    staleTimeMs: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error("Reconnect to load dashboard data.");
      return fetchAuthorizedDashboardHistory(() => client.getDashboardMetrics());
    },
  });
  return { query, availability, count };
}

const AVAILABILITY_MESSAGE = {
  connecting: "Connecting to host...",
  offline: "Host offline",
  checking: "Checking dashboard availability...",
  unsupported: "Hourly collection unavailable on this host",
  rejected: "Host credentials were rejected",
};

function dashboardAvailability(
  connection: HostRuntimeConnectionStatus | undefined,
  supported: boolean | undefined,
  credentialsRejected: boolean,
): keyof typeof AVAILABILITY_MESSAGE | "available" {
  if (credentialsRejected) return "rejected";
  if (!connection || connection === "idle" || connection === "connecting") return "connecting";
  if (connection !== "online") return "offline";
  if (supported === undefined) return "checking";
  return supported ? "available" : "unsupported";
}

function DashboardStatus({
  latest,
  availability,
  count,
  query,
}: ReturnType<typeof useHostDashboard> & { latest?: DashboardSample }) {
  const { refetch, isFetching, isError, isPending } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const stale = latest && Date.now() - Date.parse(latest.at) >= 2 * DASHBOARD_HOUR_MS;
  const available = availability === "available";
  const lastAvailable = stale || !available || isError;
  let status: string | undefined;
  const accessDenied = query.data?.access === "denied";
  if (accessDenied) status = "Dashboard access denied";
  else if (!available) status = AVAILABILITY_MESSAGE[availability];
  else if (isError) status = "Could not refresh dashboard data";
  else if (!latest) {
    status = isPending ? "Loading dashboard data..." : "Waiting for first observation";
  }
  return (
    <>
      {latest ? (
        <Text style={styles.label}>
          {lastAvailable ? "Last available" : "Latest"} observation ·{" "}
          {new Date(latest.at).toLocaleString()}
        </Text>
      ) : null}
      {!latest && !accessDenied && availability !== "rejected" && count !== null && (
        <Text style={styles.label}>{count.toLocaleString()} workspaces in this session</Text>
      )}
      {status && <Text style={styles.label}>{status}</Text>}
      {available && isError && (
        <Button variant="outline" style={styles.retry} loading={isFetching} onPress={retry}>
          Retry
        </Button>
      )}
    </>
  );
}

function HostMetrics({ serverId, label }: { serverId: string; label: string }) {
  const compact = useIsCompactFormFactor();
  const [days, setDays] = useState(1);
  const [editing, setEditing] = useState(false);
  const toggleEditing = useCallback(() => setEditing((current) => !current), []);
  const hidden = useDashboardPreferences((state) => state.hidden[serverId]);
  const { query, availability, count } = useHostDashboard(serverId);
  const { latest, points, keys } = useMemo(() => {
    const data = query.data;
    const granted = availability !== "rejected" && data?.access === "granted";
    return getDashboardWindow(granted ? data.samples : [], days);
  }, [query.data, days, availability]);
  const visibleKeys = keys.filter((id) => !hidden?.includes(id));
  const showsInterval =
    visibleKeys.includes("intervalTokens") || visibleKeys.includes("intervalApiUsd");
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        <Text style={styles.heading}>{label}</Text>
        {keys.length > 0 && (
          <PressHighlight accessibilityRole="button" style={styles.control} onPress={toggleEditing}>
            <Text style={styles.action}>{editing ? "Done" : "Customize"}</Text>
          </PressHighlight>
        )}
      </View>
      <DashboardStatus latest={latest} availability={availability} count={count} query={query} />
      {latest && (
        <View style={styles.range}>
          {[1, 7, 30, 90].map((span) => (
            <RangeButton key={span} days={span} selected={days === span} choose={setDays} />
          ))}
        </View>
      )}
      {latest?.unavailable.map((source) => (
        <Text key={source} style={styles.label}>
          {source}
        </Text>
      ))}
      {showsInterval && (
        <Text style={styles.label}>
          Hourly changes cover only sessions matched across samples. The first sample and session
          resets can leave gaps.
        </Text>
      )}
      <View style={compact ? styles.compactGrid : styles.grid}>
        {editing
          ? keys.map((id) => (
              <CardToggle key={id} id={id} serverId={serverId} visible={!hidden?.includes(id)} />
            ))
          : visibleKeys.map((id) => (
              <Metric key={id} id={id} points={points} days={days} latest={latest} />
            ))}
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
  control: { minHeight: 44, justifyContent: "center" },
  section: { gap: theme.spacing[3], paddingBottom: theme.spacing[6] },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  compactGrid: { gap: theme.spacing[2] },
  card: {
    flexGrow: 1,
    flexBasis: { xs: "auto", md: 180 },
    minWidth: 0,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: 8,
  },
  heading: { color: theme.colors.foreground, fontSize: theme.fontSize.lg, flexShrink: 1 },
  value: { color: theme.colors.foreground, fontSize: 28, fontVariant: ["tabular-nums"] },
  action: { color: theme.colors.foreground, padding: theme.spacing[2] },
  label: { color: theme.colors.foregroundMuted },
  chart: { height: 32, alignItems: "flex-end", flexDirection: "row" },
  chartSlot: { flex: 1, alignItems: "center" },
  bar: { width: "75%", backgroundColor: theme.colors.foregroundMuted },
  retry: { alignSelf: "flex-start" },
}));
