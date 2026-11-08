import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsSection } from "@/components/settings";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView } from "@/components/ui/scroll-view";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { hoverStyle } from "@/styles/hover";
import {
  DrainBanners,
  FactoriesStrip,
  NeedsYouPanel,
  ScopeControls,
  StopSwitch,
} from "./overview-command";
import {
  FactoryControlNotes,
  FactoryModelsAndRoles,
  FactoryRunControls,
} from "./overview-controls";
import type { FactoryOverviewData } from "./overview-data";
import {
  IssueCard,
  LaneHeader,
  SampleTag,
  SnapshotAge,
  StageRing,
  TrackLegend,
  type CardContext,
} from "./overview-kit";
import { factoryIssueKey, type FactoryLane } from "./overview-model";
import {
  AccountPicksPanel,
  BudgetPanel,
  KpiStrip,
  LedgerTable,
  ProviderSpendPanel,
  QueueNotices,
  QuotaPanel,
  ReportCell,
  ReportGrid,
  ReportsFootnote,
  RoutingPanel,
  type FactoryKpi,
} from "./overview-reports";

type LaneFilter = FactoryLane | "all";
const LEDGER_KPIS: FactoryKpi[] = ["tokens", "spend", "costPerPr", "passRate", "queueAge"];

/**
 * Ledger: a dense operator view. A left rail holds every control and the lane filter; the main
 * column groups issues with their cost and age, then the cost ledger and budgets.
 */
export function LedgerOverview({ data }: { data: FactoryOverviewData }) {
  const compact = useIsCompactFormFactor();
  const [filter, setFilter] = useState<LaneFilter>("all");
  const [project, setProject] = useState<string | null>(null);
  // The project filter narrows the lanes; reports keep every Factory in scope.
  const view = useMemo(
    () =>
      project
        ? {
            ...data,
            lanes: data.lanes.map((group) => ({
              ...group,
              issues: group.issues.filter((issue) => issue.origin?.key === project),
            })),
          }
        : data,
    [data, project],
  );
  const rail = { data: view, filter, onFilter: setFilter, project, onProject: setProject };
  return (
    <View style={styles.stack} testID="factory-overview-ledger">
      {data.scope === "all" ? <NeedsYouPanel data={data} expanded /> : null}
      <DrainBanners data={data} />
      <View style={compact ? styles.stack : styles.columns}>
        {compact ? <CompactRail {...rail} /> : <Rail {...rail} />}
        <Main data={view} filter={filter} />
      </View>
    </View>
  );
}

interface RailProps {
  data: FactoryOverviewData;
  filter: LaneFilter;
  onFilter: (filter: LaneFilter) => void;
  project: string | null;
  onProject: (key: string | null) => void;
}

function Rail({ data, filter, onFilter, project, onProject }: RailProps) {
  const { t } = useTranslation();
  const focus = data.focus;
  const target = focus && {
    serverId: data.serverId,
    projectId: focus.projectId,
    state: focus.state,
    controls: focus.controls,
  };
  const count = data.lanes.reduce((total, group) => total + group.issues.length, 0);
  return (
    <View style={styles.rail} testID="factory-ledger-rail">
      {target ? (
        <>
          <View style={styles.railBlock}>
            <FactoryRunControls {...target} />
            <FactoryControlNotes {...target} />
            <StopSwitch data={data} />
          </View>
          <FactoryModelsAndRoles {...target} />
        </>
      ) : (
        <>
          <ScopeControls data={data} />
          <FactoriesStrip data={data} layout="rail" selected={project} onSelect={onProject} />
        </>
      )}
      {data.queue.data ? (
        <View style={styles.filterCard} accessibilityRole="tablist">
          <FilterRow
            value="all"
            label={t("projectFactory.board.allWork")}
            count={count}
            selected={filter === "all"}
            onFilter={onFilter}
          />
          {data.lanes.map((group) => (
            <FilterRow
              key={group.lane}
              value={group.lane}
              label={t(`projectFactory.stages.${group.lane}`)}
              count={group.issues.length}
              selected={filter === group.lane}
              onFilter={onFilter}
            />
          ))}
        </View>
      ) : null}
      {focus ? <RoutingPanel data={data} /> : null}
    </View>
  );
}

function FilterRow({
  value,
  label,
  count,
  selected,
  onFilter,
}: {
  value: LaneFilter;
  label: string;
  count: number;
  selected: boolean;
  onFilter: (filter: LaneFilter) => void;
}) {
  const press = useCallback(() => onFilter(value), [onFilter, value]);
  const state = useMemo(() => ({ selected }), [selected]);
  return (
    <PressHighlight
      onPress={press}
      accessibilityRole="tab"
      accessibilityState={state}
      style={[styles.filterRow, selected ? styles.filterSelected : styles.filterHover]}
      testID={`factory-ledger-filter-${value}`}
    >
      {value === "all" ? <View style={styles.allIcon} /> : <StageRing lane={value} />}
      <Text style={[styles.filterLabel, selected && styles.filterLabelSelected]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.filterCount}>{count}</Text>
    </PressHighlight>
  );
}

function CompactRail({ data, filter, onFilter, project, onProject }: RailProps) {
  const { t } = useTranslation();
  const options = useMemo<SegmentedControlOption<LaneFilter>[]>(
    () => [
      {
        value: "all",
        label: `${t("projectFactory.board.allWork")} ${data.lanes.reduce((total, group) => total + group.issues.length, 0)}`,
      },
      ...data.lanes.map((group) => ({
        value: group.lane,
        label: `${t(`projectFactory.stages.${group.lane}`)} ${group.issues.length}`,
      })),
    ],
    [data.lanes, t],
  );
  return (
    <View style={styles.compactRail}>
      <ScopeControls data={data} />
      {data.scope === "all" ? (
        <FactoriesStrip data={data} layout="rail" selected={project} onSelect={onProject} />
      ) : null}
      {data.queue.data ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <SegmentedControl options={options} value={filter} onValueChange={onFilter} size="sm" />
        </ScrollView>
      ) : null}
    </View>
  );
}

function Main({ data, filter }: { data: FactoryOverviewData; filter: LaneFilter }) {
  const { t } = useTranslation();
  const context = useMemo<CardContext>(
    () => ({
      openAgent: data.openAgent,
      usage: data.usage.byIssue,
      startedAt: data.usage.startedAt,
      ledger: true,
    }),
    [data.openAgent, data.usage],
  );
  const groups = data.lanes.filter((group) =>
    filter === "all" ? group.issues.length > 0 : group.lane === filter,
  );
  const meta = useMemo(
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
    <View style={styles.main}>
      {data.scope === "project" ? <NeedsYouPanel data={data} /> : null}
      <KpiStrip data={data} kpis={LEDGER_KPIS} />
      {data.queue.data || data.queue.error || data.queue.loading ? (
        <SettingsSection title={t("projectFactory.board.workInProgress")} trailing={meta} flush>
          <QueueNotices data={data} />
          {groups.map((group) => (
            <View key={group.lane} style={styles.group}>
              <LaneHeader lane={group.lane} count={group.issues.length} />
              <View style={styles.cards}>
                {group.issues.map((issue) => (
                  <View key={factoryIssueKey(issue)} style={styles.cardCell}>
                    <IssueCard issue={issue} lane={group.lane} context={context} />
                  </View>
                ))}
              </View>
            </View>
          ))}
        </SettingsSection>
      ) : null}
      <ReportGrid>
        <ReportCell size="lg">
          <LedgerTable data={data} />
        </ReportCell>
        <ReportCell>
          <ProviderSpendPanel data={data} />
        </ReportCell>
        <ReportCell>
          <QuotaPanel data={data} dense />
        </ReportCell>
        <ReportCell>
          <BudgetPanel data={data} />
        </ReportCell>
        <ReportCell size="sm">
          <AccountPicksPanel data={data} />
        </ReportCell>
      </ReportGrid>
      <ReportsFootnote />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  columns: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[6] },
  stack: { gap: theme.spacing[4] },
  rail: { width: 300, flexShrink: 0, gap: theme.spacing[4] },
  railBlock: { gap: theme.spacing[2] },
  compactRail: { gap: theme.spacing[3] },
  filterCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    paddingVertical: theme.spacing[1],
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 34,
    paddingHorizontal: theme.spacing[3],
    borderLeftWidth: 2,
    borderLeftColor: "transparent",
  },
  filterHover: hoverStyle({ backgroundColor: theme.colors.interactionHighlight }),
  filterSelected: {
    borderLeftColor: theme.colors.accent,
    backgroundColor: theme.colors.interactionHighlight,
  },
  allIcon: {
    width: 15,
    height: 15,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: theme.colors.foregroundMuted,
  },
  filterLabel: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  filterLabelSelected: { color: theme.colors.foreground },
  filterCount: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  main: { flex: 1, minWidth: 0, gap: theme.spacing[4] },
  meta: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3], flexWrap: "wrap" },
  group: { gap: theme.spacing[2], marginBottom: theme.spacing[2] },
  cards: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  cardCell: { flexGrow: 1, flexBasis: 280, minWidth: 240, maxWidth: 520 },
}));
