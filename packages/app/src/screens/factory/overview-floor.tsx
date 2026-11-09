import { useMemo } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings";
import { DrainBanners, FactoriesStrip, ScopeControls } from "./overview-command";
import type { FactoryOverviewData } from "./overview-data";
import {
  FactoryBoard,
  SampleTag,
  SnapshotAge,
  TrackLegend,
  type CardContext,
} from "./overview-kit";
import { shownReports } from "./overview-model";
import {
  hasReportPanels,
  KpiStrip,
  QueueNotices,
  ReportPanels,
  ReportsFootnote,
  type FactoryKpi,
  type ReportPanelItem,
} from "./overview-reports";

const FLOOR_PANELS: ReportPanelItem[] = [
  { report: "velocityChart", size: "lg" },
  { report: "categories" },
  { report: "tokenHistoryChart", size: "lg" },
  { report: "budgets" },
  { report: "quota", size: "lg" },
  { report: "costPerPrChart" },
];

const FLOOR_KPIS: FactoryKpi[] = [
  "inFlight",
  "merged7d",
  "cycleTime",
  "tokens",
  "spend",
  "passRate",
];

/**
 * Floor: the board comes first. One line of controls, full-width lanes, then the reports.
 */
export function FloorOverview({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const context = useMemo<CardContext>(
    () => ({
      openAgent: data.openAgent,
      usage: data.usage.byIssue,
      startedAt: data.usage.startedAt,
    }),
    [data.openAgent, data.usage],
  );
  // Live mode drops sample-backed reports; with none left the heading goes too.
  const hasReports =
    shownReports(FLOOR_KPIS, data.sample).length > 0 || hasReportPanels(FLOOR_PANELS, data.sample);
  const boardMeta = useMemo(
    () => (
      <View style={styles.meta}>
        <TrackLegend />
        <SnapshotAge at={data.queue.data?.fetchedAt} />
        {data.sample ? <SampleTag /> : null}
      </View>
    ),
    [data.queue.data?.fetchedAt, data.sample],
  );
  return (
    <View style={styles.page} testID="factory-overview-floor">
      <View style={styles.block}>
        <DrainBanners data={data} />
        <ScopeControls data={data} />
      </View>
      {data.scope === "all" ? (
        <SettingsSection title={t("projectFactory.scope.factories")}>
          <FactoriesStrip data={data} />
        </SettingsSection>
      ) : null}
      {data.queue.data || data.queue.error || data.queue.loading ? (
        <SettingsSection title={t("projectFactory.board.title")} trailing={boardMeta}>
          <QueueNotices data={data} />
          {data.queue.data ? <FactoryBoard lanes={data.lanes} context={context} /> : null}
        </SettingsSection>
      ) : null}
      {hasReports ? (
        <SettingsSection title={t("projectFactory.reports.title")}>
          <View style={styles.reports}>
            <KpiStrip data={data} kpis={FLOOR_KPIS} />
            <ReportPanels data={data} items={FLOOR_PANELS} />
            <ReportsFootnote data={data} />
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {},
  block: { marginBottom: theme.spacing[6], gap: theme.spacing[3] },
  meta: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3], flexWrap: "wrap" },
  reports: { gap: theme.spacing[3] },
}));
