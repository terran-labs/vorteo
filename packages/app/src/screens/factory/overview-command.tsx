import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { OctagonPause, Play } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { hoverStyle } from "@/styles/hover";
import type { Theme } from "@/styles/theme";
import type { FactoryStop } from "./all-factories-model";
import { FactoryControlStrip } from "./overview-controls";
import type { FactoryOverviewData } from "./overview-data";
import { allFactoriesOverviewRoute } from "./routes";

// ---------------------------------------------------------------------------------------------
// Icons, colored through the theme

const warningIcon = (theme: Theme) => ({ color: theme.colors.statusWarning });
const ThemedOctagonPause = withUnistyles(OctagonPause);

// ---------------------------------------------------------------------------------------------
// Scope

// ---------------------------------------------------------------------------------------------
// Stop switch and drain banner

/**
 * The global stop control, apart from a project's Pause. In All Factories it offers Stop all for
 * hosts still running and Resume all for hosts held by Stop all alone, both confirmed. A single
 * project's view only links there: resume_all acts on a whole host, which that view cannot see.
 */
export function StopSwitch({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const { stopAll, drains } = data;
  const zoomOut = useCallback(
    () => router.navigate(allFactoriesOverviewRoute(data.serverId)),
    [data.serverId],
  );
  if (data.focus) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onPress={zoomOut}
        style={styles.inAll}
        testID="factory-stop-in-all"
      >
        {t("projectFactory.stopAll.inAll")}
      </Button>
    );
  }
  if (!stopAll.available) return null;
  const busy = stopAll.pending || stopAll.projectPending !== null || data.sample;
  if (!stopAll.canStop && !stopAll.canResume) {
    return drains.length ? (
      <StatusBadge variant="warning" label={t("projectFactory.scope.states.held")} />
    ) : null;
  }
  return (
    <View style={styles.allActions}>
      {stopAll.canResume ? (
        <Button
          variant="outline"
          leftIcon={Play}
          onPress={stopAll.resumeAll}
          disabled={busy}
          testID="factory-resume-all"
        >
          {t("projectFactory.stopAll.resume")}
        </Button>
      ) : null}
      {stopAll.canStop ? (
        <Button
          variant="outline"
          leftIcon={OctagonPause}
          onPress={stopAll.stop}
          disabled={busy}
          testID="factory-stop-all"
        >
          {t("projectFactory.stopAll.stop")}
        </Button>
      ) : null}
    </View>
  );
}

/** Calm, persistent notice for each stop holding Factories, with the way back when it is ours. */
export function DrainBanners({ data }: { data: FactoryOverviewData }) {
  if (!data.drains.length && !data.stopAll.error) return null;
  return (
    <View style={styles.banners}>
      {data.drains.map((stop) => (
        <DrainBanner key={stop.key} stop={stop} data={data} />
      ))}
      {data.stopAll.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {data.stopAll.error}
        </Text>
      ) : null}
    </View>
  );
}

function DrainBanner({ stop, data }: { stop: FactoryStop; data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const date = useMemo(() => new Date(stop.pausedAt), [stop.pausedAt]);
  const age = useTimeAgo(date);
  const host = data.factories.find((entry) => entry.serverId === stop.serverId)?.hostLabel;
  return (
    <View style={styles.banner} testID="factory-drain-banner" accessibilityRole="alert">
      <ThemedOctagonPause size={16} uniProps={warningIcon} />
      <View style={styles.bannerText}>
        <Text style={styles.bannerTitle}>
          {t(
            stop.owner ? "projectFactory.stopAll.bannerTitle" : "projectFactory.stopAll.heldTitle",
            { count: stop.projects },
          )}
          {host ? <Text style={styles.muted}>{` · ${host}`}</Text> : null}
        </Text>
        <Text style={styles.muted}>
          {t(
            stop.owner
              ? "projectFactory.stopAll.bannerDetail"
              : "projectFactory.stopAll.heldDetail",
            { reason: stop.reason, age },
          )}
        </Text>
      </View>
    </View>
  );
}

/**
 * The control line for the scope: one Factory's strip with the stop switch set apart at its
 * end, or for every Factory a summary and the stop switch.
 */
export function ScopeControls({ data }: { data: FactoryOverviewData }) {
  const stop = useMemo(() => <StopSwitch data={data} />, [data]);
  if (data.focus) {
    return (
      <FactoryControlStrip
        serverId={data.serverId}
        projectId={data.focus.projectId}
        state={data.focus.state}
        controls={data.focus.controls}
        extra={stop}
      />
    );
  }
  return <AllScopeControls data={data} stop={stop} />;
}

function AllScopeControls({ data, stop }: { data: FactoryOverviewData; stop: ReactNode }) {
  const { t } = useTranslation();
  const running = data.factories.filter((entry) => entry.status === "on").length;
  return (
    <View style={styles.allBlock} testID="factory-all-controls">
      <View style={styles.allControls}>
        <Text style={styles.muted}>
          {t("projectFactory.scope.summary", {
            count: data.factories.length,
            running,
            paused: data.factories.length - running,
          })}
        </Text>
        <View style={styles.allActions}>{stop}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  spacer: { flex: 1 },
  allBlock: { gap: theme.spacing[2] },
  inAll: { alignSelf: "flex-start" },
  allActions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  stopList: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 40,
    paddingVertical: theme.spacing[1],
  },
  stopName: { flex: 1, minWidth: 0, gap: 2 },
  stopAction: { width: 84, alignItems: "flex-end" },
  allControls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  banners: { gap: theme.spacing[2] },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
  },
  bannerText: { flex: 1, minWidth: 200, gap: 2 },
  bannerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  quiet: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    minHeight: 24,
  },
  panel: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
  },
  panelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 34,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    ...hoverStyle({ backgroundColor: theme.colors.interactionHighlight }),
  },
  rowStack: { flex: 1, minWidth: 0, gap: 2, paddingVertical: theme.spacing[1.5] },
  rowText: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  rowProject: {
    maxWidth: 140,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowAge: {
    width: 56,
    textAlign: "right",
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  rowAction: {
    width: 64,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  cards: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  tile: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 240,
    maxWidth: 420,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[3],
    gap: theme.spacing[1.5],
  },
  tileHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  tileName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  tileFooter: { flexDirection: "row", justifyContent: "flex-end" },
  mini: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2], minHeight: 18 },
  miniItem: { flexDirection: "row", alignItems: "center", gap: 3 },
  miniCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  railList: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    paddingVertical: theme.spacing[1],
  },
  railRow: {
    flexDirection: "row",
    alignItems: "center",
    borderLeftWidth: 2,
    borderLeftColor: "transparent",
    paddingRight: theme.spacing[1],
  },
  railSelected: {
    borderLeftColor: theme.colors.accent,
    backgroundColor: theme.colors.interactionHighlight,
  },
  railBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
}));
