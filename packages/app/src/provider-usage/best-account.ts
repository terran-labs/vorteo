import type { QuotaAccount } from "./global-quota";
import {
  accountRunway,
  formatShortMoment,
  runwaySummary,
  type Runway,
  type RunwayState,
} from "./runway";

export interface RankedAccount {
  account: QuotaAccount;
  runway: Runway;
}

export interface BestAccount extends RankedAccount {
  /** One short line saying why, e.g. "Full on every window · resets Sun 8:00 AM". */
  reason: string;
}

export interface BestChoice {
  best: BestAccount;
  next: BestAccount | null;
  /** Nothing can take work now; best is the account that returns first. */
  waiting: boolean;
}

const TIER: Record<RunwayState, number> = {
  capacity: 0,
  low: 0,
  credits: 1,
  unknown: 2,
  out: 3,
};

/**
 * Orders accounts by which to use next. Plan capacity comes first, most remaining first; on a
 * tie the earlier reset wins, because capacity that resets sooner is lost if unused. Accounts
 * on prepaid credits follow, the one whose plan returns first leading, then accounts whose
 * usage is unknown, then accounts that are out, soonest back first. Accounts needing sign-in
 * cannot take work and are left out.
 */
export function rankAccounts(entries: readonly RankedAccount[]): RankedAccount[] {
  return entries
    .filter((entry) => !entry.account.disconnected)
    .sort((left, right) => compareRanked(left, right));
}

function compareRanked(left: RankedAccount, right: RankedAccount): number {
  const tier = TIER[left.runway.state] - TIER[right.runway.state];
  if (tier !== 0) return tier;
  if (TIER[left.runway.state] === 0) {
    const remaining = (right.account.remaining ?? 0) - (left.account.remaining ?? 0);
    if (Math.round(remaining) !== 0) return remaining;
    const reset = earliest(left.account.resetsAt, right.account.resetsAt);
    if (reset !== 0) return reset;
  } else {
    const back = earliest(left.runway.returnsAt, right.runway.returnsAt);
    if (back !== 0) return back;
  }
  return left.account.name.localeCompare(right.account.name);
}

/** Negative when left comes first; an unknown moment sorts last. */
function earliest(left: string | null, right: string | null): number {
  const leftAt = left ? Date.parse(left) : Number.POSITIVE_INFINITY;
  const rightAt = right ? Date.parse(right) : Number.POSITIVE_INFINITY;
  if (leftAt === rightAt) return 0;
  return leftAt < rightAt ? -1 : 1;
}

/** The account to use next and its runner-up, or null when there is nothing to choose. */
export function bestChoice(
  entries: readonly RankedAccount[],
  now: number,
  timeZone?: string,
): BestChoice | null {
  if (entries.length < 2) return null;
  const ranked = rankAccounts(entries);
  const [first, second] = ranked;
  if (!first) return null;
  const waiting = first.runway.state === "out";
  const usable = second && second.runway.state !== "out" ? second : null;
  return {
    best: { ...first, reason: bestReason(first, now, timeZone) },
    next: usable
      ? { ...usable, reason: runwaySummary(usable.account, usable.runway, now, timeZone) }
      : null,
    waiting,
  };
}

function bestReason(entry: RankedAccount, now: number, timeZone?: string): string {
  const { account, runway } = entry;
  const full = account.windows
    .filter((window) => !window.separate && window.remaining !== null)
    .every((window) => Math.round(window.remaining!) >= 100);
  if (runway.state === "capacity" && full && account.windows.length > 1) {
    const resets = formatShortMoment(account.resetsAt, now, timeZone);
    return resets ? `Full on every window · resets ${resets}` : "Full on every window";
  }
  return runwaySummary(account, runway, now, timeZone);
}

/** The card's row order: accounts needing sign-in first, then the ranking above. */
export function rankedRows(accounts: readonly QuotaAccount[], now: number): RankedAccount[] {
  const entries = accounts.map((account) => ({ account, runway: accountRunway(account, now) }));
  const signIn = entries.filter((entry) => entry.account.disconnected);
  return [...signIn, ...rankAccounts(entries)];
}
