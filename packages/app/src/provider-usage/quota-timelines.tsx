import { memo } from "react";
import Svg, { Circle, G, Line, Path, Text as SvgText } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { QUOTA_CELL_GAP, type QuotaCell, type QuotaCellSeries } from "./quota-timeline";

export const QUOTA_CHART_HEIGHT = 24;

interface ChartColors {
  line: string;
  low: string;
  cap: string;
  baseline: string;
  label: string;
}

const palette = (theme: Theme): { colors: ChartColors } => ({
  colors: {
    line: theme.colors.foregroundMuted,
    low: theme.colors.statusWarning,
    cap: theme.colors.destructive,
    baseline: theme.colors.border,
    label: theme.colors.foregroundExtraMuted,
  },
});

const decorativeSvgProps = isWeb
  ? { "aria-hidden": true as const }
  : {
      accessibilityElementsHidden: true,
      importantForAccessibility: "no-hide-descendants" as const,
    };

function seriesColor(series: QuotaCellSeries, colors: ChartColors): string {
  return series.state === "ok" ? colors.line : colors.low;
}

/** The climb so far: recorded readings when there are any, else the average pace. */
function climbPoints(series: QuotaCellSeries): [number, number][] {
  const recorded = series.history.filter(([fraction]) => fraction < series.elapsed);
  return [[0, 0], ...recorded, [series.elapsed, series.used]];
}

/**
 * One account's week in a cell: the filled climb to now, the pace carried on dashed, and the
 * point now. A pace that caps out before the reset draws a red stop: a dot at 100%, a solid
 * drop to the baseline, and the baseline red from there to the reset.
 */
function QuotaCellMarks({
  series,
  label,
  x0,
  width,
  colors,
}: {
  series: QuotaCellSeries;
  label: string;
  x0: number;
  width: number;
  colors: ChartColors;
}) {
  const height = QUOTA_CHART_HEIGHT;
  const x = (fraction: number) => x0 + fraction * width;
  const y = (percent: number) => height - (Math.min(100, percent) / 100) * height;
  const color = seriesColor(series, colors);
  const climb = climbPoints(series)
    .map(([fraction, percent], index) => `${index === 0 ? "M" : "L"}${x(fraction)},${y(percent)}`)
    .join(" ");
  const nowX = x(series.elapsed);
  const nowY = y(series.used);
  const cap = series.runsOutAt;
  const projectionEnd = cap ?? 1;
  const projectionY = cap === null ? y(series.projectedAtReset) : y(100);
  return (
    <G>
      <Path d={`${climb} L${nowX},${height} Z`} fill={color} opacity={0.3} />
      <Path d={climb} stroke={color} strokeWidth={1.1} fill="none" strokeLinejoin="round" />
      {series.paceKnown ? (
        <Path
          d={`M${nowX},${nowY} L${x(projectionEnd)},${projectionY}`}
          stroke={cap === null ? color : colors.cap}
          strokeWidth={1}
          strokeDasharray="2 2"
          opacity={0.9}
          fill="none"
        />
      ) : null}
      <Circle cx={nowX} cy={nowY} r={1.8} fill={color} />
      <Line
        x1={x0}
        y1={height - 0.5}
        x2={cap === null ? x0 + width : x(cap)}
        y2={height - 0.5}
        stroke={colors.baseline}
        strokeWidth={1}
      />
      {cap === null ? null : (
        <>
          <Line x1={x(cap)} y1={1.8} x2={x(cap)} y2={height} stroke={colors.cap} strokeWidth={1} />
          <Circle cx={x(cap)} cy={1.8} r={1.8} fill={colors.cap} />
          <Line
            x1={x(cap)}
            y1={height - 0.75}
            x2={x0 + width}
            y2={height - 0.75}
            stroke={colors.cap}
            strokeWidth={1.5}
          />
        </>
      )}
      <SvgText x={x0 + 1} y={7} fontSize={7} fill={colors.label}>
        {label}
      </SvgText>
    </G>
  );
}

function QuotaCellsChart({
  cells,
  cellWidth,
  colors,
}: {
  cells: readonly QuotaCell[];
  cellWidth: number;
  colors: ChartColors;
}) {
  const width = cells.length * cellWidth + QUOTA_CELL_GAP * Math.max(0, cells.length - 1);
  return (
    <Svg
      width={width}
      height={QUOTA_CHART_HEIGHT}
      viewBox={`0 0 ${width} ${QUOTA_CHART_HEIGHT}`}
      {...decorativeSvgProps}
    >
      {cells.map((cell, index) => (
        <QuotaCellMarks
          key={cell.key}
          series={cell.series}
          label={cell.label}
          x0={index * (cellWidth + QUOTA_CELL_GAP)}
          width={cellWidth}
          colors={colors}
        />
      ))}
    </Svg>
  );
}

const ThemedQuotaCellsChart = withUnistyles(QuotaCellsChart, palette);

/** Accessible text lives on the trigger around the chart, which names every account. */
export const QuotaCells = memo(function QuotaCells(props: {
  cells: readonly QuotaCell[];
  cellWidth: number;
}) {
  return <ThemedQuotaCellsChart {...props} />;
});

/** "Claude 1 82% of weekly used, caps out before reset at this pace. Codex 18% used." */
export function quotaCellsLabel(series: readonly QuotaCellSeries[]): string {
  return series
    .map((entry) => {
      const cap = entry.runsOutAt !== null ? ", caps out before reset at this pace" : "";
      return `${entry.name} ${Math.round(entry.used)}% of ${entry.windowLabel.toLowerCase()} used${cap}`;
    })
    .join(". ");
}
