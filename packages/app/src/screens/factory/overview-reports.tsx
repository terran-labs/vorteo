import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useAgentProfiles } from "@/agent-profiles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { UsageMeter } from "@/usage/meter";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatResetIn } from "@/provider-usage/format";
import type { QuotaAccount } from "@/provider-usage/global-quota";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  BudgetMeter,
  CategoryLegend,
  CategoryShareBar,
  ColumnChart,
  Panel,
  SampleTag,
  SnapshotAge,
  Sparkline,
  StackedColumnChart,
  StatTile,
  StageRing,
  categorySwatchStyles,
} from "./overview-kit";
import {
  factoryIssueKey,
  FACTORY_CATEGORIES,
  dayLabels,
  factoryLane,
  formatCompact,
  formatHours,
  formatPercent,
  formatUsd,
  hoursSince,
  median,
  type FactoryCategory,
} from "./overview-model";
import type { FactoryOverviewData } from "./overview-data";

// ---------------------------------------------------------------------------------------------
// Key figures

export type FactoryKpi =
  | "inFlight"
  | "needsYou"
  | "merged7d"
  | "cycleTime"
  | "tokens"
  | "spend"
  | "monthCap"
  | "passRate"
  | "costPerPr"
  | "queueAge";

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function KpiTile({ kpi, data }: { kpi: FactoryKpi; data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const { figures, history, usage, sample } = data;
  const k = (key: string, options?: Record<string, unknown>) =>
    t(`projectFactory.reports.kpi.${key}`, options);
  switch (kpi) {
    case "inFlight":
      return (
        <StatTile
          label={k("inFlight")}
          value={String(figures.inFlight)}
          detail={k("inFlightDetail", {
            queued: figures.counts.queued,
            blocked: figures.counts.blocked,
          })}
          sample={sample}
        />
      );
    case "needsYou":
      return (
        <StatTile
          label={k("needsYou")}
          value={String(figures.needsYou)}
          detail={k("needsYouDetail", { count: figures.repairs })}
          tone={figures.needsYou ? "warning" : undefined}
          sample={sample}
        />
      );
    case "merged7d":
      return (
        <StatTile
          label={k("merged7d")}
          value={String(sum(history.mergedPerDay.slice(-7)))}
          detail={k("merged7dDetail", { count: sum(history.mergedPerDay.slice(0, 7)) })}
          trend={history.mergedPerDay}
          sample
        />
      );
    case "cycleTime":
      return (
        <StatTile
          label={k("cycleTime")}
          value={formatHours(median(history.cycleHours))}
          detail={k("cycleTimeDetail")}
          trend={history.cycleHours.slice(-12)}
          sample
        />
      );
    case "tokens":
      return (
        <StatTile
          label={k("tokens")}
          value={formatCompact(usage.total.tokens)}
          detail={k("tokensDetail", { cached: formatCompact(usage.total.cachedTokens) })}
          sample={sample}
        />
      );
    case "spend":
      return (
        <StatTile
          label={k("spend")}
          value={formatUsd(usage.total.costUsd)}
          detail={t("projectFactory.reports.apiEquivalent")}
          sample={sample}
        />
      );
    case "monthCap": {
      const share = history.month.spentUsd / history.month.capUsd;
      let tone: "warning" | "danger" | undefined;
      if (share >= 0.9) tone = "danger";
      else if (share >= 0.75) tone = "warning";
      return (
        <StatTile
          label={k("monthCap")}
          value={formatPercent(share)}
          detail={`${formatUsd(history.month.spentUsd)} / ${formatUsd(history.month.capUsd)}`}
          tone={tone}
          sample
        />
      );
    }
    case "passRate":
      return (
        <StatTile
          label={k("passRate")}
          value={formatPercent(figures.checkPassRate)}
          detail={k("passRateDetail", { count: figures.checksFinished })}
          sample={sample}
        />
      );
    case "costPerPr":
      return (
        <StatTile
          label={k("costPerPr")}
          value={formatUsd(median(history.costPerPr.map((entry) => entry.usd)))}
          detail={t("projectFactory.reports.apiEquivalent")}
          trend={history.costPerPr.map((entry) => entry.usd)}
          sample
        />
      );
    case "queueAge":
      return <QueueAgeTile data={data} />;
  }
}

function QueueAgeTile({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const queued = data.lanes.find((group) => group.lane === "queued")?.issues ?? [];
  // The live queue does not say when an issue was opened. Sample ages only describe the sample
  // queue; matching them to live issue numbers would pass them off as readings.
  const ages = data.sample
    ? queued
        .map((issue) => data.history.queueAgeHours[issue.number])
        .filter((value): value is number => value !== undefined)
    : [];
  return (
    <StatTile
      label={t("projectFactory.reports.kpi.queueAge")}
      value={formatHours(ages.length ? Math.max(...ages) : null)}
      detail={t("projectFactory.reports.kpi.queueAgeDetail", { count: queued.length })}
      sample
    />
  );
}

export function KpiStrip({
  data,
  kpis,
}: {
  data: FactoryOverviewData;
  kpis: readonly FactoryKpi[];
}) {
  return (
    <View style={styles.kpis}>
      {kpis.map((kpi) => (
        <KpiTile key={kpi} kpi={kpi} data={data} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Panels

export function VelocityPanel({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const values = data.history.mergedPerDay;
  const labels = useMemo(() => dayLabels(values.length, data.now), [values.length, data.now]);
  return (
    <Panel title={t("projectFactory.reports.velocity")} sample>
      <ColumnChart
        values={values}
        labels={labels}
        accessibilityLabel={t("projectFactory.reports.velocityLabel", {
          count: sum(values),
          days: values.length,
        })}
      />
    </Panel>
  );
}

export function CostPerPrPanel({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const values = data.history.costPerPr.map((entry) => entry.usd);
  const labels = data.history.costPerPr.map((entry) => `#${entry.pr}`);
  return (
    <Panel title={t("projectFactory.reports.costPerPr")} sample>
      <ColumnChart
        values={values}
        labels={labels}
        format={formatUsd}
        accessibilityLabel={t("projectFactory.reports.costPerPrLabel", {
          median: formatUsd(median(values)),
        })}
      />
      <Text style={styles.footnote}>{t("projectFactory.reports.apiEquivalent")}</Text>
    </Panel>
  );
}

export function CycleTimePanel({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const hours = data.history.cycleHours;
  return (
    <Panel title={t("projectFactory.reports.kpi.cycleTime")} sample>
      <View style={styles.figureRow}>
        <Text style={styles.figure}>{formatHours(median(hours))}</Text>
        <Text style={styles.footnote}>
          {t("projectFactory.reports.cycleRange", {
            low: formatHours(Math.min(...hours)),
            high: formatHours(Math.max(...hours)),
            count: hours.length,
          })}
        </Text>
      </View>
      <Sparkline values={hours} height={40} />
    </Panel>
  );
}

/** Current threads by work category: share bar plus its table twin. */
export function CategoryPanel({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  return (
    <Panel title={t("projectFactory.reports.byCategory")} sample={data.sample}>
      <CategoryShareBar totals={data.usage.byCategory} />
      <View style={styles.tableHeader}>
        <Text style={styles.tableHeaderLabel}>{t("projectFactory.reports.category")}</Text>
        <Text style={styles.tableHeaderValue}>{t("projectFactory.reports.tokens")}</Text>
        <Text style={styles.tableHeaderValue}>{t("projectFactory.reports.estUsd")}</Text>
      </View>
      <CategoryLegend totals={data.usage.byCategory} />
      <Text style={styles.footnote}>{t("projectFactory.reports.openThreadsNote")}</Text>
    </Panel>
  );
}

export function TokenHistoryPanel({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const rows = data.history.tokensByDay;
  const labels = useMemo(() => dayLabels(rows.length, data.now), [rows.length, data.now]);
  const totals = useMemo(() => {
    const entries = FACTORY_CATEGORIES.map((category) => [
      category,
      { tokens: sum(rows.map((row) => row[category])), costUsd: null },
    ]);
    return Object.fromEntries(entries) as Record<
      FactoryCategory,
      { tokens: number; costUsd: number | null }
    >;
  }, [rows]);
  return (
    <Panel title={t("projectFactory.reports.tokensByDay")} sample>
      <StackedColumnChart
        rows={rows}
        labels={labels}
        accessibilityLabel={t("projectFactory.reports.tokensByDayLabel", {
          total: formatCompact(sum(Object.values(totals).map((entry) => entry.tokens))),
        })}
      />
      <CategoryLegend totals={totals} showValues={false} />
    </Panel>
  );
}

export function QuotaPanel({ data, dense }: { data: FactoryOverviewData; dense?: boolean }) {
  const { t } = useTranslation();
  const { accounts, sample } = data.quota;
  return (
    <Panel title={t("projectFactory.reports.quota")} sample={sample} testID="factory-quota">
      {accounts.length === 0 ? (
        <Text style={styles.footnote}>{t("projectFactory.reports.quotaEmpty")}</Text>
      ) : null}
      {accounts.map((account) => (
        <QuotaAccountBlock
          key={account.providerId}
          account={account}
          spend={data.quota.spend[account.providerId]}
          dense={dense}
        />
      ))}
    </Panel>
  );
}

function QuotaAccountBlock({
  account,
  spend,
  dense,
}: {
  account: QuotaAccount;
  spend: number | undefined;
  dense?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.account}>
      <View style={styles.accountHeader}>
        <Text style={styles.accountName} numberOfLines={1}>
          {account.name}
          {account.plan ? <Text style={styles.muted}>{` · ${account.plan}`}</Text> : null}
        </Text>
        <Text style={styles.muted}>
          {t("projectFactory.reports.runningAgents", { count: account.running })}
        </Text>
      </View>
      {account.status ? <Text style={styles.warning}>{account.status}</Text> : null}
      {account.windows.map((window) => (
        <QuotaWindowRow key={window.id} window={window} dense={dense} />
      ))}
      <View style={styles.accountFooter}>
        <Text style={styles.muted}>
          {spend !== undefined
            ? t("projectFactory.reports.accountSpend", { amount: formatUsd(spend) })
            : t("projectFactory.reports.accountSpendMissing")}
        </Text>
        <SnapshotAge at={account.fetchedAt} />
      </View>
    </View>
  );
}

function QuotaWindowRow({
  window,
  dense,
}: {
  window: QuotaAccount["windows"][number];
  dense?: boolean;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const brief = dense || compact;
  const used = window.remaining === null ? null : 100 - window.remaining;
  let tone: "ok" | "warning" | "danger" = "ok";
  if (used !== null && used >= 90) tone = "danger";
  else if (used !== null && used >= 75) tone = "warning";
  const reset = formatResetIn(window.resetsAt);
  const history = useMemo(() => window.history.map((point) => point.used), [window.history]);
  return (
    <View style={styles.window}>
      <Text style={styles.windowLabel} numberOfLines={1}>
        {window.label}
      </Text>
      <View style={styles.windowMeter}>
        <UsageMeter percent={used ?? 0} tone={tone} />
      </View>
      <Text style={styles.windowValue}>{used === null ? "—" : `${Math.round(used)}%`}</Text>
      {brief ? null : (
        <Text style={styles.windowReset} numberOfLines={1}>
          {reset ? t("projectFactory.reports.resets", { time: reset }) : "—"}
        </Text>
      )}
      {!brief && history.length > 1 ? (
        <View style={styles.windowSpark}>
          <Sparkline values={history} height={18} max={100} />
        </View>
      ) : null}
    </View>
  );
}

export function BudgetPanel({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const { month, ticketCapUsd } = data.history;
  const costs = [...data.usage.byIssue.entries()]
    .map(([key, usage]) => ({ number: Number(key.split("#").pop()), usd: usage.costUsd }))
    .filter((entry): entry is { number: number; usd: number } => entry.usd !== null)
    .sort((a, b) => b.usd - a.usd);
  const worst = costs[0];
  return (
    <Panel title={t("projectFactory.reports.budgets")} sample>
      <BudgetMeter
        label={t("projectFactory.reports.monthCap")}
        used={month.spentUsd}
        limit={month.capUsd}
        detail={t("projectFactory.reports.monthPace", {
          day: month.day,
          days: month.days,
          projected: formatUsd((month.spentUsd / month.day) * month.days),
        })}
      />
      <BudgetMeter
        label={
          worst
            ? t("projectFactory.reports.ticketCapWorst", { number: worst.number })
            : t("projectFactory.reports.ticketCap")
        }
        used={worst?.usd ?? null}
        limit={ticketCapUsd}
      />
      <Text style={styles.footnote}>{t("projectFactory.reports.capsNote")}</Text>
    </Panel>
  );
}

export function ProviderSpendPanel({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const rows = data.usage.byProvider;
  return (
    <Panel title={t("projectFactory.reports.byProvider")} sample={data.sample}>
      {rows.length === 0 ? (
        <Text style={styles.footnote}>{t("projectFactory.reports.noThreads")}</Text>
      ) : (
        <View style={styles.tableHeader}>
          <Text style={styles.tableHeaderLabel}>{t("projectFactory.reports.provider")}</Text>
          <Text style={styles.tableHeaderValue}>{t("projectFactory.reports.threads")}</Text>
          <Text style={styles.tableHeaderValue}>{t("projectFactory.reports.tokens")}</Text>
          <Text style={styles.tableHeaderValue}>{t("projectFactory.reports.estUsd")}</Text>
        </View>
      )}
      {rows.map((row) => (
        <View key={row.provider} style={styles.tableRow}>
          <Text style={styles.tableLabel} numberOfLines={1}>
            {row.provider}
          </Text>
          <Text style={styles.tableValue}>{row.agents}</Text>
          <Text style={styles.tableValue}>{formatCompact(row.usage.tokens)}</Text>
          <Text style={styles.tableValue}>{formatUsd(row.usage.costUsd)}</Text>
        </View>
      ))}
      <Text style={styles.footnote}>{t("projectFactory.reports.apiEquivalent")}</Text>
    </Panel>
  );
}

export function AccountPicksPanel({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const picks = data.history.accountPicks;
  const top = Math.max(1, ...picks.map((entry) => entry.picks));
  return (
    <Panel title={t("projectFactory.reports.accountPicks")} sample>
      {picks.map((entry) => (
        <View key={entry.account} style={styles.window}>
          <Text style={styles.pickLabel} numberOfLines={1}>
            {entry.account}
          </Text>
          <View style={styles.windowMeter}>
            <UsageMeter percent={(entry.picks / top) * 100} tone="default" />
          </View>
          <Text style={styles.windowValue}>{entry.picks}</Text>
        </View>
      ))}
    </Panel>
  );
}

/** Which profile each stage and role launches with: read from the live Factory state. */
export function RoutingPanel({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const { profiles } = useAgentProfiles(data.serverId);
  const name = useCallback(
    (id: string | null | undefined) =>
      id
        ? (profiles?.find((profile) => profile.id === id)?.name ??
          t("projectFactory.unavailableProfile"))
        : t("projectFactory.defaultModel"),
    [profiles, t],
  );
  if (!data.focus) return null;
  const { workers, roles } = data.focus.state;
  const rows: { key: string; label: string; value: string }[] = [
    ...(workers.plannerProfileId !== undefined
      ? [{ key: "plan", label: t("projectFactory.plan"), value: name(workers.plannerProfileId) }]
      : []),
    { key: "build", label: t("projectFactory.build"), value: name(workers.workerProfileId) },
    { key: "review", label: t("projectFactory.review"), value: name(workers.reviewerProfileId) },
    ...roles.map((role) => ({
      key: role.role,
      label: role.title,
      value: name(role.launch.profileId),
    })),
  ];
  return (
    <Panel title={t("projectFactory.reports.routing")}>
      {rows.map((row) => (
        <View key={row.key} style={styles.tableRow}>
          <Text style={styles.tableLabel}>{row.label}</Text>
          <Text style={styles.routingValue} numberOfLines={1}>
            {row.value}
          </Text>
        </View>
      ))}
    </Panel>
  );
}

/** Per-issue cost rollup: the table twin of the board. */
export function LedgerTable({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const issues = data.lanes.flatMap((group) => group.issues);
  return (
    <Panel
      title={t("projectFactory.reports.ledger")}
      sample={data.sample}
      age={data.queue.data?.fetchedAt}
    >
      <View style={styles.tableHeader}>
        <Text style={styles.tableHeaderLabel}>{t("projectFactory.reports.issue")}</Text>
        <Text style={styles.tableHeaderValue}>{t("projectFactory.reports.age")}</Text>
        <Text style={styles.tableHeaderValue}>{t("projectFactory.reports.tokens")}</Text>
        <Text style={styles.tableHeaderValue}>{t("projectFactory.reports.estUsd")}</Text>
      </View>
      {issues.map((issue) => (
        <LedgerRow
          key={factoryIssueKey(issue)}
          number={issue.number}
          title={issue.title}
          url={issue.url}
          lane={factoryLane(issue.stage)}
          tokens={data.usage.byIssue.get(factoryIssueKey(issue))?.tokens ?? null}
          usd={data.usage.byIssue.get(factoryIssueKey(issue))?.costUsd ?? null}
          hours={hoursSince(data.usage.startedAt.get(factoryIssueKey(issue)) ?? null, data.now)}
        />
      ))}
      <LedgerTotal data={data} />
    </Panel>
  );
}

function LedgerRow({
  number,
  title,
  url,
  lane,
  tokens,
  usd,
  hours,
}: {
  number: number;
  title: string;
  url: string;
  lane: ReturnType<typeof factoryLane>;
  tokens: number | null;
  usd: number | null;
  hours: number | null;
}) {
  const open = useCallback(() => {
    void openExternalUrl(url).catch(console.error);
  }, [url]);
  return (
    <PressHighlight onPress={open} accessibilityRole="link" style={styles.ledgerRow}>
      <View style={styles.ledgerIssue}>
        <StageRing lane={lane} />
        <Text style={styles.ledgerNumber}>#{number}</Text>
        <Text style={styles.ledgerTitle} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Text style={styles.tableValue}>{formatHours(hours)}</Text>
      <Text style={styles.tableValue}>{formatCompact(tokens)}</Text>
      <Text style={styles.tableValue}>{formatUsd(usd)}</Text>
    </PressHighlight>
  );
}

function LedgerTotal({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  let tokens: number | null = null;
  let usd: number | null = null;
  for (const usage of data.usage.byIssue.values()) {
    if (usage.tokens !== null) tokens = (tokens ?? 0) + usage.tokens;
    if (usage.costUsd !== null) usd = (usd ?? 0) + usage.costUsd;
  }
  return (
    <View style={[styles.tableRow, styles.totalRow]}>
      <Text style={styles.totalLabel}>{t("projectFactory.reports.issueTotal")}</Text>
      <Text style={styles.tableValue} />
      <Text style={styles.totalValue}>{formatCompact(tokens)}</Text>
      <Text style={styles.totalValue}>{formatUsd(usd)}</Text>
    </View>
  );
}

/** Small legend explaining the dash, shown once under report grids. */
export function ReportsFootnote() {
  const { t } = useTranslation();
  return (
    <View style={styles.footRow}>
      <SampleTag />
      <Text style={styles.footnote}>{t("projectFactory.reports.footnote")}</Text>
    </View>
  );
}

export function CategorySwatch({ category }: { category: FactoryCategory }) {
  return <View style={[styles.swatch, categorySwatchStyles[category]]} />;
}

const styles = StyleSheet.create((theme) => ({
  kpis: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  footnote: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  footRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warning: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  figureRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  figure: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["3xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tableHeaderLabel: {
    flex: 1,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  tableHeaderValue: {
    minWidth: 56,
    textAlign: "right",
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  tableRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], minHeight: 24 },
  tableLabel: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  tableValue: {
    minWidth: 56,
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  routingValue: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[1],
  },
  totalLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  totalValue: {
    minWidth: 56,
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
  ledgerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    borderRadius: theme.borderRadius.md,
  },
  ledgerIssue: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  ledgerNumber: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  ledgerTitle: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  account: { gap: theme.spacing[1.5] },
  accountHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  accountName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  accountFooter: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[2] },
  window: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], minHeight: 20 },
  windowLabel: { width: 52, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  pickLabel: { width: 120, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  windowMeter: { flex: 1, minWidth: 48 },
  windowValue: {
    width: 36,
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  windowReset: { width: 92, color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  windowSpark: { width: 64 },
}));

// ---------------------------------------------------------------------------------------------
// Layout helpers shared by the designs

/** Wrapping grid of report panels; each cell grows from its basis. */
export function ReportGrid({ children }: { children: ReactNode }) {
  return <View style={layout.grid}>{children}</View>;
}

export function ReportCell({
  size = "md",
  children,
}: {
  size?: "sm" | "md" | "lg";
  children: ReactNode;
}) {
  return <View style={layout[size]}>{children}</View>;
}

/** Queue fetch states shared by every design: errors with Retry, loading and idle. */
export function QueueNotices({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const { queue } = data;
  const failure = queue.error?.message ?? queue.data?.error ?? null;
  return (
    <>
      {failure ? (
        <View style={layout.notice}>
          <Text style={styles.warning} accessibilityRole="alert">
            {failure}
          </Text>
          <Button onPress={queue.reload} disabled={queue.fetching}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {queue.loading ? <Text style={styles.muted}>{t("common.loading")}</Text> : null}
      {queue.data && queue.data.issues.length === 0 && !queue.data.error ? (
        <Text style={styles.muted}>{t("projectFactory.idle")}</Text>
      ) : null}
    </>
  );
}

const layout = StyleSheet.create((theme) => ({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3], alignItems: "stretch" },
  // Cells shrink to the column on phones instead of holding their basis past the edge.
  sm: { flexGrow: 1, flexShrink: 1, flexBasis: 260, maxWidth: "100%" },
  md: { flexGrow: 1, flexShrink: 1, flexBasis: 340, maxWidth: "100%" },
  lg: { flexGrow: 2, flexShrink: 1, flexBasis: 520, maxWidth: "100%" },
  notice: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[3] },
}));
