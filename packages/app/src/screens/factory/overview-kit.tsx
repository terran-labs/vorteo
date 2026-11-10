import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView } from "@/components/ui/scroll-view";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { ExternalLink } from "@/components/ui/external-link";
import { UsageMeter } from "@/usage/meter";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { hoverStyle } from "@/styles/hover";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  factoryIssueKey,
  FACTORY_CATEGORIES,
  FACTORY_LANES,
  FACTORY_TRACK_STEPS,
  factoryTrack,
  formatCompact,
  formatUsd,
  type FactoryCategory,
  type FactoryIssue,
  type FactoryLane,
  type FactoryLaneGroup,
  type FactoryTrackState,
  type UsageTotals,
} from "./overview-model";
import { factoryAgentStatusKey } from "./queue";

// ---------------------------------------------------------------------------------------------
// Color. Categorical slots follow the validated reference order (adjacent CVD ΔE ≥ 8 in both
// schemes against the card surfaces). Lanes reuse the slot of their work category so a lane
// stripe and its token bar share a hue. Status colors stay reserved for state.

const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7"];
const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"];

function series(theme: Theme): string[] {
  return theme.colorScheme === "dark" ? SERIES_DARK : SERIES_LIGHT;
}

export function categoryColor(theme: Theme, category: FactoryCategory): string {
  return series(theme)[FACTORY_CATEGORIES.indexOf(category)]!;
}

function laneColor(theme: Theme, lane: FactoryLane): string {
  switch (lane) {
    case "queued":
      return theme.colors.foregroundExtraMuted;
    case "planning":
      return categoryColor(theme, "planning");
    case "building":
      return categoryColor(theme, "build");
    case "review":
      return categoryColor(theme, "review");
    case "merging":
      return categoryColor(theme, "release");
    case "blocked":
      return theme.colors.statusDanger;
  }
}

interface ChartColors {
  ink: string;
  muted: string;
  grid: string;
  surface: string;
  accent: string;
  quiet: string;
  categories: string[];
  lanes: Record<FactoryLane, string>;
  track: Record<FactoryTrackState, string>;
}

const chartColors = (theme: Theme): { colors: ChartColors } => ({
  colors: {
    ink: theme.colors.foreground,
    muted: theme.colors.foregroundMuted,
    grid: theme.colors.border,
    surface: theme.colors.surface1,
    accent: theme.colors.statusDotRunning,
    quiet: theme.colors.foregroundExtraMuted,
    categories: FACTORY_CATEGORIES.map((category) => categoryColor(theme, category)),
    lanes: Object.fromEntries(
      FACTORY_LANES.map((lane) => [lane, laneColor(theme, lane)]),
    ) as Record<FactoryLane, string>,
    track: {
      done: theme.colors.statusDotSuccess,
      active: theme.colors.statusDotRunning,
      failed: theme.colors.statusDotDanger,
      blocked: theme.colors.statusDotWarning,
      pending: theme.colors.surface3,
    },
  },
});

const decorativeSvgProps = isWeb
  ? { "aria-hidden": true as const }
  : {
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants" as const,
    };

/** Width of a flexible chart, measured once laid out. */
export function useMeasuredWidth(): [number, (event: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    setWidth((current) => (Math.abs(current - next) > 1 ? next : current));
  }, []);
  return [width, onLayout];
}

// ---------------------------------------------------------------------------------------------
// Labels and frames

export function SampleTag() {
  const { t } = useTranslation();
  return <StatusBadge size="xs" label={t("projectFactory.reports.sample")} />;
}

/** "Updated 3m ago" for a snapshot, so every reading shows its age. */
export function SnapshotAge({ at }: { at: string | null | undefined }) {
  const { t } = useTranslation();
  const date = useMemo(() => (at ? new Date(at) : null), [at]);
  const age = useTimeAgo(date);
  if (!date) return null;
  return <Text style={styles.age}>{t("projectFactory.reports.asOf", { age })}</Text>;
}

/** A titled report surface. Sample-backed panels always carry the tag. */
export function Panel({
  title,
  sample,
  age,
  trailing,
  children,
  testID,
}: {
  title: string;
  sample?: boolean;
  age?: string | null;
  trailing?: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.panel} testID={testID}>
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.panelMeta}>
          {age !== undefined ? <SnapshotAge at={age} /> : null}
          {sample ? <SampleTag /> : null}
          {trailing}
        </View>
      </View>
      {children}
    </View>
  );
}

export function StatTile({
  label,
  value,
  detail,
  sample,
  trend,
  tone,
  testID,
}: {
  label: string;
  value: string;
  detail?: string;
  sample?: boolean;
  trend?: readonly number[];
  tone?: "warning" | "danger";
  testID?: string;
}) {
  return (
    <View style={styles.tile} testID={testID}>
      <Text style={styles.tileLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={[
          styles.tileValue,
          tone === "warning" && styles.toneWarning,
          tone === "danger" && styles.toneDanger,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
      {detail ? (
        <Text style={styles.tileDetail} numberOfLines={2}>
          {detail}
        </Text>
      ) : null}
      {trend && trend.length > 1 ? <Sparkline values={trend} height={22} /> : null}
      {sample ? (
        <View style={styles.tileTag}>
          <SampleTag />
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Charts

function SparklineMarks({
  values,
  width,
  height,
  max,
  colors,
}: {
  values: readonly number[];
  width: number;
  height: number;
  max?: number;
  colors: ChartColors;
}) {
  const top = max ?? Math.max(1, ...values);
  const pad = 4;
  const x = (index: number) => pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2);
  const y = (value: number) => pad + (1 - Math.min(1, value / top)) * (height - pad * 2);
  const d = values.map((value, index) => `${index ? "L" : "M"}${x(index)},${y(value)}`).join(" ");
  const last = values.length - 1;
  return (
    <Svg width={width} height={height} {...decorativeSvgProps}>
      <Path
        d={d}
        stroke={colors.quiet}
        strokeWidth={1.5}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <Circle cx={x(last)} cy={y(values[last]!)} r={4} fill={colors.surface} />
      <Circle cx={x(last)} cy={y(values[last]!)} r={2.5} fill={colors.accent} />
    </Svg>
  );
}
const ThemedSparkline = withUnistyles(SparklineMarks, chartColors);

/** A 12-ish point trend in the de-emphasis hue, with the latest point in the accent. */
export const Sparkline = memo(function Sparkline({
  values,
  height,
  max,
}: {
  values: readonly number[];
  height: number;
  max?: number;
}) {
  const [width, onLayout] = useMeasuredWidth();
  const frame = useMemo(() => ({ height }), [height]);
  return (
    <View style={frame} onLayout={onLayout}>
      {width > 0 ? (
        <ThemedSparkline values={values} width={width} height={height} max={max} />
      ) : null}
    </View>
  );
});

/** Rounded data end, square at the baseline. */
function columnPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
}

const AXIS_BAND = 16;

function ColumnMarks({
  values,
  labels,
  width,
  height,
  format,
  colors,
}: {
  values: readonly number[];
  labels: readonly string[];
  width: number;
  height: number;
  format: (value: number) => string;
  colors: ChartColors;
}) {
  const plot = height - AXIS_BAND;
  const top = Math.max(1, ...values);
  const slot = width / values.length;
  const bar = Math.min(24, Math.max(2, slot - 2));
  const peak = values.indexOf(Math.max(...values));
  const last = values.length - 1;
  return (
    <Svg width={width} height={height} {...decorativeSvgProps}>
      {values.map((value, index) => {
        const h = Math.max(value > 0 ? 2 : 0, ((value / top) * (plot - 14)) | 0);
        const x = index * slot + (slot - bar) / 2;
        return (
          <Path
            // Days are positional; the index is the identity.
            key={labels[index] ?? index}
            d={columnPath(x, plot - h, bar, h)}
            fill={index === last ? colors.accent : colors.categories[0]}
            opacity={index === last ? 1 : 0.55}
          />
        );
      })}
      <Line
        x1={0}
        y1={plot + 0.5}
        x2={width}
        y2={plot + 0.5}
        stroke={colors.grid}
        strokeWidth={1}
      />
      <ColumnLabel
        index={peak}
        values={values}
        slot={slot}
        plot={plot}
        top={top}
        format={format}
        colors={colors}
      />
      {peak !== last ? (
        <ColumnLabel
          index={last}
          values={values}
          slot={slot}
          plot={plot}
          top={top}
          format={format}
          colors={colors}
        />
      ) : null}
      <SvgLabel x={2} y={height - 3} anchor="start" text={labels[0] ?? ""} fill={colors.muted} />
      <SvgLabel
        x={width - 2}
        y={height - 3}
        anchor="end"
        text={labels[last] ?? ""}
        fill={colors.muted}
      />
    </Svg>
  );
}

function ColumnLabel({
  index,
  values,
  slot,
  plot,
  top,
  format,
  colors,
}: {
  index: number;
  values: readonly number[];
  slot: number;
  plot: number;
  top: number;
  format: (value: number) => string;
  colors: ChartColors;
}) {
  const value = values[index] ?? 0;
  const h = (value / top) * (plot - 14);
  return (
    <SvgLabel
      x={index * slot + slot / 2}
      y={plot - h - 3}
      anchor="middle"
      text={format(value)}
      fill={colors.ink}
    />
  );
}

/** Every chart label shares one size and stays in text tokens, never the data color. */
function SvgLabel({
  x,
  y,
  anchor,
  text,
  fill,
}: {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  text: string;
  fill: string;
}) {
  return (
    <SvgText x={x} y={y} fontSize={10} fill={fill} textAnchor={anchor}>
      {text}
    </SvgText>
  );
}

const ThemedColumns = withUnistyles(ColumnMarks, chartColors);

/** One series of columns: the latest in the accent, the peak and latest labelled. */
export function ColumnChart({
  values,
  labels,
  height = 96,
  format = formatCompact,
  accessibilityLabel,
}: {
  values: readonly number[];
  labels: readonly string[];
  height?: number;
  format?: (value: number) => string;
  accessibilityLabel: string;
}) {
  const [width, onLayout] = useMeasuredWidth();
  const frame = useMemo(() => ({ height }), [height]);
  return (
    <View style={frame} onLayout={onLayout} accessible accessibilityLabel={accessibilityLabel}>
      {width > 0 ? (
        <ThemedColumns
          values={values}
          labels={labels}
          width={width}
          height={height}
          format={format}
        />
      ) : null}
    </View>
  );
}

function StackedMarks({
  rows,
  labels,
  width,
  height,
  colors,
}: {
  rows: readonly Record<FactoryCategory, number>[];
  labels: readonly string[];
  width: number;
  height: number;
  colors: ChartColors;
}) {
  const plot = height - AXIS_BAND;
  const totals = rows.map((row) => FACTORY_CATEGORIES.reduce((sum, key) => sum + row[key], 0));
  const top = Math.max(1, ...totals);
  const slot = width / rows.length;
  const bar = Math.min(24, Math.max(4, slot - 6));
  const last = rows.length - 1;
  return (
    <Svg width={width} height={height} {...decorativeSvgProps}>
      {rows.map((row, index) => (
        <StackedColumn
          key={labels[index] ?? index}
          row={row}
          x={index * slot + (slot - bar) / 2}
          bar={bar}
          plot={plot}
          top={top}
          colors={colors}
        />
      ))}
      <Line
        x1={0}
        y1={plot + 0.5}
        x2={width}
        y2={plot + 0.5}
        stroke={colors.grid}
        strokeWidth={1}
      />
      <SvgLabel
        x={last * slot + slot / 2}
        y={plot - ((totals[last] ?? 0) / top) * (plot - 14) - 4}
        anchor="middle"
        text={formatCompact(totals[last] ?? 0)}
        fill={colors.ink}
      />
      <SvgLabel x={2} y={height - 3} anchor="start" text={labels[0] ?? ""} fill={colors.muted} />
      <SvgLabel
        x={width - 2}
        y={height - 3}
        anchor="end"
        text={labels[last] ?? ""}
        fill={colors.muted}
      />
    </Svg>
  );
}

function StackedColumn({
  row,
  x,
  bar,
  plot,
  top,
  colors,
}: {
  row: Record<FactoryCategory, number>;
  x: number;
  bar: number;
  plot: number;
  top: number;
  colors: ChartColors;
}) {
  let y = plot;
  const segments = FACTORY_CATEGORIES.map((category, index) => {
    const h = (row[category] / top) * (plot - 14);
    y -= h;
    return { category, y, h, color: colors.categories[index]! };
  }).filter((segment) => segment.h >= 1);
  return (
    <>
      {segments.map((segment, index) => (
        <Rect
          key={segment.category}
          x={x}
          y={segment.y}
          width={bar}
          // A 2px surface gap separates touching segments.
          height={Math.max(0.5, segment.h - (index === segments.length - 1 ? 0 : 2))}
          rx={index === segments.length - 1 ? 2 : 0}
          fill={segment.color}
        />
      ))}
    </>
  );
}

const ThemedStacked = withUnistyles(StackedMarks, chartColors);

export function StackedColumnChart({
  rows,
  labels,
  height = 120,
  accessibilityLabel,
}: {
  rows: readonly Record<FactoryCategory, number>[];
  labels: readonly string[];
  height?: number;
  accessibilityLabel: string;
}) {
  const [width, onLayout] = useMeasuredWidth();
  const frame = useMemo(() => ({ height }), [height]);
  return (
    <View style={frame} onLayout={onLayout} accessible accessibilityLabel={accessibilityLabel}>
      {width > 0 ? (
        <ThemedStacked rows={rows} labels={labels} width={width} height={height} />
      ) : null}
    </View>
  );
}

/** Legend and table twin for category charts: swatch, name, tokens and dollars. */
export function CategoryLegend({
  totals,
  showValues = true,
}: {
  totals: Record<FactoryCategory, { tokens: number | null; costUsd: number | null }>;
  showValues?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={showValues ? styles.legendTable : styles.legendInline}>
      {FACTORY_CATEGORIES.map((category) => (
        <View key={category} style={showValues ? styles.legendRow : styles.legendItem}>
          <View style={[styles.swatch, swatchStyles[category]]} />
          <Text style={styles.legendLabel} numberOfLines={1}>
            {t(`projectFactory.reports.categories.${category}`)}
          </Text>
          {showValues ? (
            <>
              <Text style={styles.legendValue}>{formatCompact(totals[category].tokens)}</Text>
              <Text style={styles.legendValue}>{formatUsd(totals[category].costUsd)}</Text>
            </>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** One horizontal part-to-whole bar of token share by category, with 2px gaps. */
export function CategoryShareBar({
  totals,
}: {
  totals: Record<FactoryCategory, { tokens: number | null }>;
}) {
  const sum = FACTORY_CATEGORIES.reduce((total, key) => total + (totals[key].tokens ?? 0), 0);
  if (!sum) return <View style={styles.shareEmpty} />;
  return (
    <View style={styles.shareBar}>
      {FACTORY_CATEGORIES.filter((key) => (totals[key].tokens ?? 0) > 0).map((category) => (
        <ShareSegment
          key={category}
          category={category}
          share={(totals[category].tokens ?? 0) / sum}
        />
      ))}
    </View>
  );
}

function ShareSegment({ category, share }: { category: FactoryCategory; share: number }) {
  const grow = useMemo(() => ({ flexGrow: share }), [share]);
  return <View style={[styles.shareSegment, swatchStyles[category], grow]} />;
}

/** A budget or quota meter: fill carries severity, track stays quiet. */
export function BudgetMeter({
  label,
  used,
  limit,
  format = formatUsd,
  detail,
  sample,
}: {
  label: string;
  used: number | null;
  limit: number | null;
  format?: (value: number | null) => string;
  detail?: string;
  sample?: boolean;
}) {
  const percent = used !== null && limit ? (used / limit) * 100 : 0;
  let tone: "ok" | "warning" | "danger" = "ok";
  if (percent >= 90) tone = "danger";
  else if (percent >= 75) tone = "warning";
  return (
    <View style={styles.meter}>
      <View style={styles.meterHeader}>
        <Text style={styles.meterLabel} numberOfLines={1}>
          {label}
        </Text>
        {sample ? <SampleTag /> : null}
        <Text style={styles.meterValue}>
          {format(used)}
          <Text style={styles.meterLimit}>{limit !== null ? ` / ${format(limit)}` : ""}</Text>
        </Text>
      </View>
      <UsageMeter percent={percent} tone={tone} />
      {detail ? <Text style={styles.meterDetail}>{detail}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Board

function RingMarks({ lane, colors }: { lane: FactoryLane; colors: ChartColors }) {
  const color = colors.lanes[lane];
  const index = FACTORY_LANES.indexOf(lane);
  // Progress through the pipeline: an empty ring for queued, a full disc for merging.
  const share = lane === "blocked" ? 0 : index / 4;
  const r = 5.5;
  const c = 2 * Math.PI * r;
  return (
    <Svg width={15} height={15} viewBox="0 0 15 15" {...decorativeSvgProps}>
      <Circle cx={7.5} cy={7.5} r={6.5} fill="none" stroke={color} strokeWidth={1.5} />
      {share > 0 ? (
        <Circle
          cx={7.5}
          cy={7.5}
          r={r / 2}
          fill="none"
          stroke={color}
          strokeWidth={r}
          strokeDasharray={`${(c / 2) * share} ${c}`}
          transform="rotate(-90 7.5 7.5)"
        />
      ) : null}
      {lane === "blocked" ? (
        <Line x1={4.5} y1={10.5} x2={10.5} y2={4.5} stroke={color} strokeWidth={1.5} />
      ) : null}
    </Svg>
  );
}
const ThemedRing = withUnistyles(RingMarks, chartColors);

export function StageRing({ lane }: { lane: FactoryLane }) {
  return <ThemedRing lane={lane} />;
}

export function LaneHeader({ lane, count }: { lane: FactoryLane; count: number }) {
  const { t } = useTranslation();
  return (
    <View style={styles.laneHeader}>
      <StageRing lane={lane} />
      <Text style={styles.laneTitle} numberOfLines={1}>
        {t(`projectFactory.stages.${lane}`)}
      </Text>
      <Text style={styles.laneCount}>{count}</Text>
    </View>
  );
}

export interface CardContext {
  /** Opens an agent thread; undefined for sample threads that do not exist. */
  openAgent?: (agentId: string, serverId?: string) => void;
  usage?: Map<string, UsageTotals>;
  startedAt?: Map<string, Date | null>;
  /** Show per-issue cost and age on the card. */
  ledger?: boolean;
}

export function Lane({
  group,
  context,
  width,
}: {
  group: FactoryLaneGroup;
  context: CardContext;
  /** A lane in a row takes its share of the row; alone it fills its parent. */
  width?: number;
}) {
  const { t } = useTranslation();
  const sized = useMemo(() => (width ? { width } : null), [width]);
  return (
    <View style={[styles.lane, sized]} testID={`factory-lane-${group.lane}`}>
      <LaneHeader lane={group.lane} count={group.issues.length} />
      <View style={styles.laneBody}>
        {group.issues.length === 0 ? (
          <Text style={styles.laneEmpty}>{t("projectFactory.board.empty")}</Text>
        ) : null}
        {group.issues.map((issue) => (
          <IssueCard
            key={factoryIssueKey(issue)}
            issue={issue}
            lane={group.lane}
            context={context}
          />
        ))}
      </View>
    </View>
  );
}

const reviewVariant: Record<string, StatusBadgeVariant> = {
  APPROVED: "success",
  CHANGES_REQUESTED: "error",
};
const checksVariant: Record<"pending" | "passing" | "failing", StatusBadgeVariant> = {
  pending: "muted",
  passing: "success",
  failing: "error",
};

export function IssueCard({
  issue,
  lane,
  context,
}: {
  issue: FactoryIssue;
  lane: FactoryLane;
  context: CardContext;
}) {
  const open = useCallback(() => {
    void openExternalUrl(issue.url).catch(console.error);
  }, [issue.url]);
  return (
    <View style={[styles.card, stripeStyles[lane]]} testID={`factory-issue-${issue.number}`}>
      {issue.origin ? (
        <Text style={styles.cardProject} numberOfLines={1}>
          {issue.origin.label}
        </Text>
      ) : null}
      <PressHighlight onPress={open} accessibilityRole="link" style={styles.cardTitleRow}>
        <Text style={styles.cardNumber}>#{issue.number}</Text>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {issue.title}
        </Text>
      </PressHighlight>
      <IssueMeta issue={issue} />
      {issue.agents.length ? <AgentChips issue={issue} openAgent={context.openAgent} /> : null}
      <View style={styles.cardFooter}>
        <TrackBoxes issue={issue} />
        {context.ledger ? <IssueCost issue={issue} context={context} /> : null}
      </View>
    </View>
  );
}

function IssueMeta({ issue }: { issue: FactoryIssue }) {
  const { t } = useTranslation();
  const decision = issue.pr?.reviewDecision ?? null;
  const foreign = issue.claim && !issue.claim.local;
  const hasMeta = issue.pr || issue.stage === "repair" || issue.label === "human-review" || foreign;
  if (!hasMeta) return null;
  return (
    <View style={styles.meta}>
      {issue.label === "human-review" ? (
        <StatusBadge size="xs" variant="warning" label={t("projectFactory.board.needsYou")} />
      ) : null}
      {issue.stage === "repair" ? (
        <StatusBadge size="xs" variant="error" label={t("projectFactory.stages.repair")} />
      ) : null}
      {issue.pr ? (
        <ExternalLink
          href={issue.pr.url}
          label={t("projectFactory.pullRequest", { number: issue.pr.number })}
        />
      ) : null}
      {issue.pr?.checks ? (
        <StatusBadge
          size="xs"
          variant={checksVariant[issue.pr.checks]}
          label={t(`projectFactory.board.checks.${issue.pr.checks}`)}
        />
      ) : null}
      {decision ? (
        <StatusBadge
          size="xs"
          variant={reviewVariant[decision] ?? "muted"}
          label={reviewLabel(decision, t)}
        />
      ) : null}
      {foreign ? (
        <StatusBadge
          size="xs"
          variant="warning"
          label={
            issue.claim?.installation
              ? t("projectFactory.assignment.claimedBy", { installation: issue.claim.installation })
              : t("projectFactory.assignment.claimedElsewhere")
          }
        />
      ) : null}
    </View>
  );
}

function reviewLabel(decision: string, t: (key: string) => string): string {
  switch (decision) {
    case "APPROVED":
      return t("projectFactory.board.review.approved");
    case "CHANGES_REQUESTED":
      return t("projectFactory.board.review.changesRequested");
    case "REVIEW_REQUIRED":
      return t("projectFactory.board.review.required");
    default:
      return decision.toLowerCase().replaceAll("_", " ");
  }
}

function AgentChips({
  issue,
  openAgent,
}: {
  issue: FactoryIssue;
  openAgent?: (agentId: string, serverId?: string) => void;
}) {
  return (
    <View style={styles.chips}>
      {issue.agents.map((agent) => (
        <AgentChip
          key={agent.agentId}
          agentId={agent.agentId}
          role={agent.role}
          status={agent.status}
          serverId={issue.origin?.serverId}
          openAgent={openAgent}
        />
      ))}
    </View>
  );
}

function statusDotStyle(status: string) {
  switch (status) {
    case "running":
    case "initializing":
      return styles.dotRunning;
    case "completed":
      return styles.dotDone;
    case "error":
    case "failed":
      return styles.dotFailed;
    default:
      return styles.dotIdle;
  }
}

function AgentChip({
  agentId,
  role,
  status,
  serverId,
  openAgent,
}: {
  agentId: string;
  role: FactoryIssue["agents"][number]["role"];
  status: string;
  serverId?: string;
  openAgent?: (agentId: string, serverId?: string) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => openAgent?.(agentId, serverId), [agentId, openAgent, serverId]);
  const roleLabel = t(`projectFactory.agents.${role}`);
  const statusLabel = t(factoryAgentStatusKey(status));
  return (
    <PressHighlight
      onPress={press}
      disabled={!openAgent}
      accessibilityRole="button"
      accessibilityLabel={t("projectFactory.board.openAgent", {
        role: roleLabel,
        status: statusLabel,
      })}
      style={[styles.chip, openAgent ? styles.chipHover : null]}
      hitSlop={6}
    >
      <View style={[styles.dot, statusDotStyle(status)]} />
      <Text style={styles.chipRole}>{roleLabel}</Text>
      <Text style={styles.chipStatus}>{statusLabel}</Text>
    </PressHighlight>
  );
}

const trackStateStyle = (state: FactoryTrackState) => trackStyles[state];

/** Plan · Build · Review · Merge · Deploy as five boxes. */
export function TrackBoxes({ issue }: { issue: Pick<FactoryIssue, "stage" | "pr"> }) {
  const { t } = useTranslation();
  const track = factoryTrack(issue);
  const label = FACTORY_TRACK_STEPS.map(
    (step, index) =>
      `${t(`projectFactory.board.track.${step}`)}: ${t(`projectFactory.board.trackStates.${track[index]!}`)}`,
  ).join(", ");
  return (
    <View style={styles.track} accessible accessibilityLabel={label}>
      {FACTORY_TRACK_STEPS.map((step, index) => (
        <View key={step} style={[styles.trackBox, trackStateStyle(track[index]!)]} />
      ))}
    </View>
  );
}

function IssueCost({ issue, context }: { issue: FactoryIssue; context: CardContext }) {
  const usage = context.usage?.get(factoryIssueKey(issue));
  const started = context.startedAt?.get(factoryIssueKey(issue)) ?? null;
  const age = useTimeAgo(started);
  return (
    <Text style={styles.cardCost} numberOfLines={1}>
      {`${formatCompact(usage?.tokens)} · ${formatUsd(usage?.costUsd)}${started ? ` · ${age}` : ""}`}
    </Text>
  );
}

/** Lanes side by side, scrolling sideways when the window is narrower than the board. */
export function LaneRow({
  lanes,
  context,
}: {
  lanes: readonly FactoryLaneGroup[];
  context: CardContext;
}) {
  const [width, onLayout] = useMeasuredWidth();
  // Lanes share the row evenly and never shrink below a readable card; past that the row scrolls.
  const laneWidth = Math.max(
    LANE_MIN_WIDTH,
    Math.floor((width - LANE_GAP * (lanes.length - 1)) / lanes.length),
  );
  return (
    <View onLayout={onLayout}>
      {width > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          contentContainerStyle={styles.laneRow}
          style={[styles.laneScroller, styles.edgeScroller]}
        >
          {lanes.map((group) => (
            <Lane key={group.lane} group={group} context={context} width={laneWidth} />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const LANE_MIN_WIDTH = 232;
const LANE_GAP = 12;

/** Compact layouts show one lane at a time behind a lane picker. */
export function LaneTabs({
  lanes,
  context,
}: {
  lanes: readonly FactoryLaneGroup[];
  context: CardContext;
}) {
  const { t } = useTranslation();
  const firstBusy = lanes.find((group) => group.issues.length > 0)?.lane ?? "queued";
  const [selected, setSelected] = useState<FactoryLane>(firstBusy);
  const options = useMemo<SegmentedControlOption<FactoryLane>[]>(
    () =>
      lanes.map((group) => ({
        value: group.lane,
        label: `${t(`projectFactory.stages.${group.lane}`)} ${group.issues.length}`,
        testID: `factory-lane-tab-${group.lane}`,
      })),
    [lanes, t],
  );
  const group = lanes.find((entry) => entry.lane === selected) ?? lanes[0]!;
  return (
    <View style={styles.laneTabs}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.edgeScroller}
        contentContainerStyle={styles.edgeContent}
      >
        <SegmentedControl
          options={options}
          value={selected}
          onValueChange={setSelected}
          size="sm"
        />
      </ScrollView>
      <Lane group={group} context={context} />
    </View>
  );
}

/** Lanes side by side on wide layouts; one lane at a time behind a picker on compact ones. */
export function FactoryBoard({
  lanes,
  context,
}: {
  lanes: readonly FactoryLaneGroup[];
  context: CardContext;
}) {
  const compact = useIsCompactFormFactor();
  return compact ? (
    <LaneTabs lanes={lanes} context={context} />
  ) : (
    <LaneRow lanes={lanes} context={context} />
  );
}

// ---------------------------------------------------------------------------------------------
// Styles

const styles = StyleSheet.create((theme) => ({
  age: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  panel: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    minWidth: 0,
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: 20,
  },
  panelTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  panelMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  tile: {
    flexGrow: 1,
    flexBasis: 150,
    minWidth: 140,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
  },
  tileLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tileValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["3xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  tileTag: { flexDirection: "row", marginTop: "auto", paddingTop: theme.spacing[1] },
  tileDetail: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  toneWarning: { color: theme.colors.statusWarning },
  toneDanger: { color: theme.colors.statusDanger },
  legendTable: { gap: theme.spacing[1] },
  legendInline: { flexDirection: "row", flexWrap: "wrap", columnGap: theme.spacing[3], rowGap: 4 },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  legendLabel: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  legendValue: {
    minWidth: 56,
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  shareBar: { flexDirection: "row", height: 10, gap: 2 },
  shareEmpty: { height: 10, borderRadius: 3, backgroundColor: theme.colors.surface3 },
  shareSegment: { height: 10, borderRadius: 2, flexBasis: 0, minWidth: 2 },
  meter: { gap: theme.spacing[1] },
  meterHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  meterLabel: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  meterValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  meterLimit: { color: theme.colors.foregroundExtraMuted },
  meterDetail: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  laneScroller: { flexGrow: 0 },
  laneRow: { gap: LANE_GAP, alignItems: "flex-start", paddingHorizontal: theme.spacing[4] },
  edgeScroller: { marginHorizontal: -theme.spacing[4] },
  edgeContent: { paddingHorizontal: theme.spacing[4] },
  lane: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  laneHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingTop: theme.spacing[1],
    minHeight: 24,
  },
  laneTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  laneCount: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  laneBody: { gap: theme.spacing[2] },
  laneEmpty: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  laneTabs: { gap: theme.spacing[3] },
  card: {
    borderWidth: 1,
    borderLeftWidth: 3,
    borderColor: theme.colors.border,
    borderRadius: 10,
    backgroundColor: theme.colors.surface2,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: 10,
    gap: theme.spacing[2],
    ...hoverStyle({ borderColor: theme.colors.borderAccent }),
  },
  cardProject: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: -theme.spacing[1],
  },
  cardTitleRow: { flexDirection: "row", gap: theme.spacing[1.5], alignItems: "flex-start" },
  cardNumber: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    lineHeight: 19,
  },
  cardTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 19,
    ...hoverStyle({ color: theme.colors.accentBright }),
  },
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  chipHover: hoverStyle({ backgroundColor: theme.colors.interactionHighlight }),
  chipRole: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  chipStatus: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotRunning: { backgroundColor: theme.colors.statusDotRunning },
  dotDone: { backgroundColor: theme.colors.statusDotSuccess },
  dotFailed: { backgroundColor: theme.colors.statusDotDanger },
  dotIdle: { backgroundColor: theme.colors.foregroundExtraMuted },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  track: { flexDirection: "row", gap: 2, flexShrink: 0 },
  trackBox: { width: 14, height: 5, borderRadius: 1.5 },
  trackLegend: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  cardCost: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));

const stripeStyles = StyleSheet.create((theme) => ({
  queued: { borderLeftColor: laneColor(theme, "queued") },
  planning: { borderLeftColor: laneColor(theme, "planning") },
  building: { borderLeftColor: laneColor(theme, "building") },
  review: { borderLeftColor: laneColor(theme, "review") },
  merging: { borderLeftColor: laneColor(theme, "merging") },
  blocked: { borderLeftColor: laneColor(theme, "blocked") },
}));

const swatchStyles = StyleSheet.create((theme) => ({
  triage: { backgroundColor: categoryColor(theme, "triage") },
  planning: { backgroundColor: categoryColor(theme, "planning") },
  build: { backgroundColor: categoryColor(theme, "build") },
  review: { backgroundColor: categoryColor(theme, "review") },
  repair: { backgroundColor: categoryColor(theme, "repair") },
  release: { backgroundColor: categoryColor(theme, "release") },
  mechanic: { backgroundColor: categoryColor(theme, "mechanic") },
}));

const trackStyles = StyleSheet.create((theme) => ({
  done: { backgroundColor: theme.colors.statusDotSuccess },
  active: { backgroundColor: theme.colors.statusDotRunning },
  failed: { backgroundColor: theme.colors.statusDotDanger },
  blocked: { backgroundColor: theme.colors.statusDotWarning },
  pending: { backgroundColor: theme.colors.surface4 },
}));

export { swatchStyles as categorySwatchStyles, stripeStyles as laneStripeStyles };
