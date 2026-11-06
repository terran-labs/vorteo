import type { QuotaAccount, QuotaWindowRow } from "./global-quota";

const HOUR_MS = 60 * 60 * 1000;
const SESSION_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** How much of a window must pass before its pace predicts anything. */
const MIN_PACE_MS = 24 * HOUR_MS;

/**
 * One account's week: how usage climbed since its long window opened, and where the current
 * pace leads. A pace that reaches 100% before the reset leaves the account without quota from
 * `runsOutAt` until the reset.
 */
export interface QuotaCellSeries {
  key: string;
  /** Two or three characters for the cell's corner, such as "C1". */
  label: string;
  name: string;
  family: string;
  windowLabel: string;
  /** Percent used now. */
  used: number;
  /** Fraction of the window already elapsed, 0 to 1. */
  elapsed: number;
  /** Fraction of the window where the pace reaches 100%; null when it lasts to the reset. */
  runsOutAt: number | null;
  /** Percent used at the reset at the current pace, capped at 100. */
  projectedAtReset: number;
  /** False during the window's first day, when its pace predicts nothing yet. */
  paceKnown: boolean;
  /** Recorded readings in this window as [fraction of window, percent used]. */
  history: [number, number][];
  state: "ok" | "low" | "capping";
}

/** A cell as drawn: one account, or a provider family shown by its riskiest account. */
export interface QuotaCell {
  key: string;
  label: string;
  series: QuotaCellSeries;
  /** Accounts the cell stands for; above 1 for a family cell. */
  count: number;
}

export interface QuotaCellLayout {
  cells: QuotaCell[];
  cellWidth: number;
  /** Families left out for lack of room; shown as +N only when above zero. */
  overflow: number;
}

export const QUOTA_CELL_GAP = 3;
/** Below this a cell cannot show its label and cap marks legibly. */
export const QUOTA_CELL_MIN_WIDTH = 22;
/** Room the +N count takes, including its gap. */
export const QUOTA_OVERFLOW_WIDTH = 24;

/**
 * Window lengths are not on the wire. Session windows (Claude `five_hour`, Codex `session`) last
 * five hours; every other enforced window here is weekly.
 */
export function quotaWindowLengthMs(window: Pick<QuotaWindowRow, "id">): number {
  return window.id === "five_hour" || window.id === "session" ? SESSION_MS : WEEK_MS;
}

/** This view follows the long window: the enforced weekly window with the least left. */
function weeklyWindow(account: QuotaAccount): QuotaWindowRow | null {
  const candidates = account.windows.filter(
    (window) => !window.separate && window.remaining !== null && window.resetsAt !== null,
  );
  const weekly = candidates.filter((window) => quotaWindowLengthMs(window) === WEEK_MS);
  const pool = weekly.length > 0 ? weekly : candidates;
  if (pool.length === 0) return null;
  return pool.reduce((least, window) =>
    (window.remaining ?? 100) < (least.remaining ?? 100) ? window : least,
  );
}

/** `claude-account-…` belongs to the Claude family. */
export function quotaProviderFamily(providerId: string): string {
  return providerId.split("-")[0] || providerId;
}

const FAMILY_LETTERS: Record<string, string> = { claude: "C", codex: "X" };

function familyLetter(family: string): string {
  return FAMILY_LETTERS[family] ?? family.charAt(0).toUpperCase();
}

function shortLabel(family: string, name: string, index: number): string {
  const number = /(\d+)(?!.*\d)/.exec(name)?.[1] ?? String(index + 1);
  return `${familyLetter(family)}${number}`;
}

function cellState(used: number, runsOutAt: number | null): QuotaCellSeries["state"] {
  if (runsOutAt !== null || used >= 100) return "capping";
  return used >= 70 ? "low" : "ok";
}

export function quotaCellSeries(accounts: readonly QuotaAccount[], now: number): QuotaCellSeries[] {
  const perFamily = new Map<string, number>();
  return accounts.flatMap((account): QuotaCellSeries[] => {
    if (account.disconnected) return [];
    const window = weeklyWindow(account);
    const reset = window?.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (!window || !Number.isFinite(reset)) return [];
    const length = quotaWindowLengthMs(window);
    const start = reset - length;
    const elapsed = Math.min(1, Math.max(0, (now - start) / length));
    const used = Math.min(100, 100 - (window.remaining ?? 100));
    // A few hours of a week say little about its pace: 5% used two hours in would project far
    // past 100%. Predict a cap, and draw the pace forward, only after the first day.
    const settled = now - start >= MIN_PACE_MS && elapsed > 0;
    const pace = settled ? used / elapsed : 0;
    const runsOutAt = settled && pace > 100 ? Math.max(elapsed, 100 / pace) : null;
    const family = quotaProviderFamily(account.providerId);
    const index = perFamily.get(family) ?? 0;
    perFamily.set(family, index + 1);
    const history = window.history
      .filter((point) => point.at >= start && point.at <= now)
      .map((point): [number, number] => [(point.at - start) / length, point.used]);
    return [
      {
        key: account.providerId,
        label: shortLabel(family, account.name, index),
        name: account.name,
        family,
        windowLabel: window.label,
        used,
        elapsed,
        runsOutAt,
        projectedAtReset: settled ? Math.min(100, pace) : used,
        paceKnown: settled,
        history,
        state: cellState(used, runsOutAt),
      },
    ];
  });
}

/** Earliest run-out first, then most used: the order cells give way in when room runs short. */
function riskOrder(left: QuotaCellSeries, right: QuotaCellSeries): number {
  const leftOut = left.runsOutAt ?? Infinity;
  const rightOut = right.runsOutAt ?? Infinity;
  if (leftOut !== rightOut) return leftOut - rightOut;
  return right.used - left.used;
}

function cellsFit(count: number, width: number): boolean {
  return count > 0 && (width - QUOTA_CELL_GAP * (count - 1)) / count >= QUOTA_CELL_MIN_WIDTH;
}

/** Cells split the chart's width evenly; the chart, not the cell, decides how wide they get. */
function cellWidthFor(count: number, width: number): number {
  const share = (width - QUOTA_CELL_GAP * (count - 1)) / Math.max(1, count);
  return Math.max(QUOTA_CELL_MIN_WIDTH, share);
}

/** The chart takes at least this share of the footer row. */
export const QUOTA_CHART_MIN_SHARE = 0.55;

/**
 * How wide the chart is: at least `QUOTA_CHART_MIN_SHARE` of the row, and the whole free room
 * when that is what keeps every account in its own cell. What is left is open space between the
 * installation name and the chart.
 */
export function quotaChartWidth(
  series: readonly QuotaCellSeries[],
  rowWidth: number,
  room: number,
): number {
  if (room <= 0) return 0;
  const preferred = Math.min(room, Math.round(rowWidth * QUOTA_CHART_MIN_SHARE));
  return cellsFit(series.length, preferred) ? preferred : room;
}

/**
 * Every account shares the width while each cell stays legible. When they do not fit, each
 * provider family takes one cell showing its riskiest account. Only when even the families do
 * not fit do the riskiest stay and the rest become a +N count.
 */
export function quotaCellLayout(
  series: readonly QuotaCellSeries[],
  width: number,
): QuotaCellLayout {
  if (series.length === 0 || width <= 0) return { cells: [], cellWidth: 0, overflow: 0 };
  if (cellsFit(series.length, width)) {
    const cells = series.map((entry) => ({
      key: entry.key,
      label: entry.label,
      series: entry,
      count: 1,
    }));
    return { cells, cellWidth: cellWidthFor(cells.length, width), overflow: 0 };
  }
  const families = new Map<string, QuotaCellSeries[]>();
  for (const entry of series)
    families.set(entry.family, [...(families.get(entry.family) ?? []), entry]);
  const groups = [...families.entries()]
    .map(([family, members]): QuotaCell => {
      const worst = [...members].sort(riskOrder)[0]!;
      return {
        key: family,
        label: members.length > 1 ? `${familyLetter(family)}·${members.length}` : worst.label,
        series: worst,
        count: members.length,
      };
    })
    .sort((left, right) => riskOrder(left.series, right.series));
  if (cellsFit(groups.length, width)) {
    return { cells: groups, cellWidth: cellWidthFor(groups.length, width), overflow: 0 };
  }
  const room = width - QUOTA_OVERFLOW_WIDTH;
  const fit = Math.max(
    1,
    Math.floor((room + QUOTA_CELL_GAP) / (QUOTA_CELL_MIN_WIDTH + QUOTA_CELL_GAP)),
  );
  const shown = groups.slice(0, fit);
  return {
    cells: shown,
    cellWidth: cellWidthFor(shown.length, room),
    overflow: groups.length - shown.length,
  };
}
