import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings";
import { DrainBanners, FactoriesStrip, NeedsYouPanel, ScopeControls } from "./overview-command";
import type { FactoryOverviewData } from "./overview-data";
import {
  FactoryBoard,
  Panel,
  SampleTag,
  StageRing,
  TrackLegend,
  type CardContext,
} from "./overview-kit";
import { FACTORY_LANES, type FactoryLane } from "./overview-model";
import {
  AccountPicksPanel,
  BudgetPanel,
  CategoryPanel,
  KpiStrip,
  QueueNotices,
  QuotaPanel,
  ReportCell,
  ReportGrid,
  ReportsFootnote,
  TokenHistoryPanel,
  VelocityPanel,
  type FactoryKpi,
} from "./overview-reports";

const MISSION_KPIS: FactoryKpi[] = [
  "merged7d",
  "cycleTime",
  "tokens",
  "monthCap",
  "passRate",
  "costPerPr",
];

/**
 * Mission: the dashboard comes first. A hero figure beside the controls, key figures, the
 * pipeline as a line of stations, quota and token use side by side, then the board.
 */
export function MissionOverview({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const context = useMemo<CardContext>(
    () => ({
      openAgent: data.openAgent,
      usage: data.usage.byIssue,
      startedAt: data.usage.startedAt,
    }),
    [data.openAgent, data.usage],
  );
  const boardMeta = useMemo(() => <TrackLegend />, []);
  return (
    <View style={styles.page} testID="factory-overview-mission">
      {data.scope === "all" ? <NeedsYouPanel data={data} expanded /> : null}
      <DrainBanners data={data} />
      <View style={styles.band}>
        <Hero data={data} />
        <View style={styles.bandControls}>
          <ScopeControls data={data} />
        </View>
      </View>
      {data.scope === "project" ? <NeedsYouPanel data={data} /> : null}
      <KpiStrip data={data} kpis={MISSION_KPIS} />
      {data.scope === "all" ? <FactoriesStrip data={data} /> : null}
      {data.queue.data ? (
        <Panel
          title={t("projectFactory.reports.pipeline")}
          sample={data.sample}
          age={data.queue.data.fetchedAt}
        >
          <Pipeline data={data} />
        </Panel>
      ) : null}
      <ReportGrid>
        <ReportCell size="lg">
          <QuotaPanel data={data} />
        </ReportCell>
        <ReportCell>
          <CategoryPanel data={data} />
        </ReportCell>
      </ReportGrid>
      <ReportGrid>
        <ReportCell size="lg">
          <TokenHistoryPanel data={data} />
        </ReportCell>
        <ReportCell>
          <BudgetPanel data={data} />
        </ReportCell>
        <ReportCell>
          <VelocityPanel data={data} />
        </ReportCell>
        <ReportCell size="sm">
          <AccountPicksPanel data={data} />
        </ReportCell>
      </ReportGrid>
      {data.queue.data || data.queue.error || data.queue.loading ? (
        <SettingsSection title={t("projectFactory.board.title")} trailing={boardMeta} flush>
          <QueueNotices data={data} />
          {data.queue.data ? <FactoryBoard lanes={data.lanes} context={context} /> : null}
        </SettingsSection>
      ) : null}
      <ReportsFootnote />
    </View>
  );
}

function Hero({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const { figures } = data;
  return (
    <View style={styles.hero}>
      <View style={styles.heroLabelRow}>
        <Text style={styles.heroLabel}>{t("projectFactory.reports.kpi.inFlight")}</Text>
        {data.sample ? <SampleTag /> : null}
      </View>
      <Text style={styles.heroValue}>{figures.inFlight}</Text>
      <Text style={styles.heroDetail}>
        {t("projectFactory.reports.heroDetail", {
          needsYou: figures.needsYou,
          blocked: figures.counts.blocked,
          queued: figures.counts.queued,
        })}
      </Text>
    </View>
  );
}

const PIPELINE: FactoryLane[] = FACTORY_LANES.filter((lane) => lane !== "blocked");

/** The stations an issue passes through, with blocked work held off the line. */
function Pipeline({ data }: { data: FactoryOverviewData }) {
  return (
    <View style={styles.pipeline}>
      <View style={styles.line}>
        {PIPELINE.map((lane, index) => (
          <Station
            key={lane}
            lane={lane}
            count={data.figures.counts[lane]}
            first={index === 0}
            last={index === PIPELINE.length - 1}
            note={lane === "review" ? data.figures.repairs : 0}
          />
        ))}
      </View>
      <View style={styles.offLine}>
        <Station lane="blocked" count={data.figures.counts.blocked} first last note={0} />
      </View>
    </View>
  );
}

function Station({
  lane,
  count,
  first,
  last,
  note,
}: {
  lane: FactoryLane;
  count: number;
  first: boolean;
  last: boolean;
  note: number;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.station}>
      <View style={styles.rail}>
        <View style={[styles.railLine, first && styles.railHidden]} />
        <StageRing lane={lane} />
        <View style={[styles.railLine, last && styles.railHidden]} />
      </View>
      <Text style={[styles.stationCount, count === 0 && styles.stationEmpty]}>{count}</Text>
      <Text style={styles.stationLabel} numberOfLines={1}>
        {t(`projectFactory.stages.${lane}`)}
      </Text>
      {note ? (
        <Text style={styles.stationNote} numberOfLines={1}>
          {t("projectFactory.reports.inRepair", { count: note })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { gap: theme.spacing[4] },
  band: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[6],
    paddingBottom: theme.spacing[2],
  },
  bandControls: { flexGrow: 1, flexBasis: 360, minWidth: 0 },
  hero: { gap: theme.spacing[0.5], minWidth: 180 },
  heroLabelRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  heroLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  heroValue: {
    color: theme.colors.foreground,
    fontSize: 52,
    lineHeight: 56,
    fontWeight: theme.fontWeight.semibold,
  },
  heroDetail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  pipeline: { flexDirection: "row", gap: theme.spacing[4], alignItems: "flex-start" },
  line: { flex: 1, flexDirection: "row" },
  offLine: {
    width: 72,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    paddingLeft: theme.spacing[2],
  },
  station: { flex: 1, alignItems: "center", gap: 2, minWidth: 0 },
  rail: { flexDirection: "row", alignItems: "center", alignSelf: "stretch", height: 15 },
  railLine: { flex: 1, height: 1, backgroundColor: theme.colors.borderAccent },
  railHidden: { backgroundColor: "transparent" },
  stationCount: {
    marginTop: theme.spacing[1],
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  stationEmpty: { color: theme.colors.foregroundExtraMuted },
  stationLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  stationNote: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
