import { formatAmount } from "./format";
import type { QuotaAccount, QuotaWindowRow } from "./global-quota";
import { deriveTone } from "./tone";

export const RUNWAY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What an account can do at a moment: work on its plan, work on a plan that is nearly spent,
 * draw from prepaid credits, nothing at all, or nothing the card can tell.
 */
export type RunwayState = "capacity" | "low" | "credits" | "out" | "unknown";

/** A stretch of the lane, as fractions of the horizon starting at now. */
export interface RunwaySegment {
  state: RunwayState;
  start: number;
  end: number;
}

export interface Runway {
  segments: RunwaySegment[];
  /** Fractions of the horizon where a known reset lands. */
  resets: number[];
  /** The state at now. */
  state: RunwayState;
  /** When an account on credits or out regains its plan; null when no reset is known. */
  returnsAt: string | null;
}

interface Allowance {
  remaining: number;
  resetsAt: number | null;
}

/**
 * Projects each account's next week from its windows: a window keeps its current remaining
 * percent until its reset, then counts as full. Only the windows that stop ordinary work
 * count; code review is separate. A reading observed from the account's last limit message
 * becomes unknown after its reset, because nothing says what the other windows hold.
 */
export function accountRunway(
  account: QuotaAccount,
  now: number,
  horizonMs = RUNWAY_HORIZON_MS,
): Runway {
  const allowances = account.disconnected ? [] : accountAllowances(account);
  const end = now + horizonMs;
  const resetTimes = uniqueSorted(
    allowances
      .map((entry) => entry.resetsAt)
      .filter((at): at is number => at !== null && at > now && at <= end),
  );
  const stateAt = (t: number) =>
    runwayState(levelAt(allowances, t, account.observed), account.credits);
  const boundaries = [now, ...resetTimes.filter((at) => at < end), end];
  const segments: RunwaySegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const from = boundaries[index]!;
    const state = stateAt(from);
    const start = (from - now) / horizonMs;
    const stop = (boundaries[index + 1]! - now) / horizonMs;
    const last = segments[segments.length - 1];
    if (last && last.state === state) last.end = stop;
    else segments.push({ state, start, end: stop });
  }
  const state = segments[0]!.state;
  const waiting = state === "credits" || state === "out";
  // The limit lifts at its reset even when what follows is unknown.
  const recovery = segments.find(
    (segment) => segment.state !== "credits" && segment.state !== "out",
  );
  const returnsAt =
    waiting && recovery ? new Date(now + recovery.start * horizonMs).toISOString() : null;
  return {
    segments,
    resets: resetTimes.map((at) => (at - now) / horizonMs),
    state,
    returnsAt,
  };
}

function accountAllowances(account: QuotaAccount): Allowance[] {
  const windows = account.windows.filter(
    (window): window is QuotaWindowRow & { remaining: number } =>
      !window.separate && window.remaining !== null,
  );
  if (windows.length) return windows.map((window) => allowance(window.remaining, window.resetsAt));
  // Accounts that report only a capped balance, such as a monthly plan budget, run on it.
  const capped = account.balances.find(
    (balance) => balance.limit !== null && balance.remaining !== null,
  );
  if (!capped) return [];
  return [allowance((100 * capped.remaining!) / capped.limit!, capped.resetsAt)];
}

function allowance(remaining: number, iso: string | null): Allowance {
  const parsed = iso ? Date.parse(iso) : NaN;
  const resetsAt = Number.isFinite(parsed) ? parsed : null;
  return { remaining, resetsAt };
}

function levelAt(allowances: readonly Allowance[], t: number, observed: boolean): number | null {
  if (!allowances.length) return null;
  let level = 100;
  for (const entry of allowances) {
    const reset = entry.resetsAt !== null && entry.resetsAt <= t;
    if (reset && observed) return null;
    if (!reset) level = Math.min(level, entry.remaining);
  }
  return level;
}

function runwayState(level: number | null, credits: number | null): RunwayState {
  if (level === null) return "unknown";
  if (Math.round(level) <= 0) return credits === null ? "out" : "credits";
  // The same percent reads as a warning wherever tone.ts colors usage: 30% left or less.
  if (deriveTone(100 - level) !== "default") return "low";
  return "capacity";
}

/**
 * Windows that reset together report moments a few seconds apart; one notch stands for each
 * cluster, at its latest moment so every window in it has reset there.
 */
function uniqueSorted(times: number[]): number[] {
  const sorted = [...times].sort((left, right) => left - right);
  const unique: number[] = [];
  for (const at of sorted) {
    const last = unique.length - 1;
    if (last >= 0 && at - unique[last]! < 60_000) unique[last] = at;
    else unique.push(at);
  }
  return unique;
}

/**
 * Local midnights inside the horizon, for the shared day axis. Each day is labeled at its
 * middle so the name sits over the day it names; a partial day at either end may fall outside.
 */
export function dayTicks(now: number, horizonMs = RUNWAY_HORIZON_MS): DayTick[] {
  const ticks: DayTick[] = [];
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const day = new Date(now);
  day.setHours(24, 0, 0, 0);
  while (day.getTime() < now + horizonMs) {
    const start = day.getTime();
    day.setDate(day.getDate() + 1);
    ticks.push({
      at: (start - now) / horizonMs,
      center: ((start + day.getTime()) / 2 - now) / horizonMs,
      label: weekday.format(start),
    });
  }
  return ticks;
}

export interface DayTick {
  /** Where the day starts. */
  at: number;
  /** Where the day's label goes. */
  center: number;
  label: string;
}

/** "11:00 PM" later today, "Tue 10:40 PM" on another day. */
export function formatShortMoment(
  iso: string | null,
  now: number,
  timeZone?: string,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" });
  const time = new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (dayKey.format(date) === dayKey.format(new Date(now))) return time;
  const weekday = new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short" }).format(date);
  return `${weekday} ${time}`;
}

/** The one line under a lane, such as "23% left · resets Tue 10:40 PM". */
export function runwaySummary(
  account: QuotaAccount,
  runway: Runway,
  now: number,
  timeZone?: string,
): string {
  const returns = formatShortMoment(runway.returnsAt, now, timeZone);
  switch (account.disconnected ? "disconnected" : runway.state) {
    case "disconnected":
      return account.status ?? "Account disconnected";
    case "capacity":
    case "low": {
      const resets = formatShortMoment(account.resetsAt, now, timeZone);
      const left = `${Math.round(account.remaining!)}% left`;
      return resets ? `${left} · resets ${resets}` : left;
    }
    case "credits": {
      const amount = `${formatAmount(account.credits!, "credits")} credits`;
      return returns ? `${amount} · plan back ${returns}` : amount;
    }
    case "out":
      return returns ? `Out until ${returns}` : "Out of quota";
    default:
      return account.status ?? "Usage unavailable";
  }
}

/** The single label a row earns, only for states that change what the owner can do. */
export function runwayLabel(account: QuotaAccount, runway: Runway): RunwayLabel | null {
  if (account.disconnected) return null;
  if (runway.state === "out") return { text: "Out", tone: "danger" };
  if (runway.state === "credits") return { text: "On credits", tone: "muted" };
  return null;
}

export interface RunwayLabel {
  text: string;
  tone: "danger" | "muted";
}

const STATE_TEXT: Record<RunwayState, string> = {
  capacity: "plan capacity",
  low: "running low",
  credits: "prepaid credits",
  out: "out of quota",
  unknown: "unknown",
};

/** The lane read aloud: "prepaid credits until Tue 10:36 PM, then plan capacity". */
export function runwayDescription(
  runway: Runway,
  now: number,
  horizonMs = RUNWAY_HORIZON_MS,
  timeZone?: string,
): string {
  return runway.segments
    .map((segment) => {
      if (segment.end >= 1) return STATE_TEXT[segment.state];
      const until = new Date(now + segment.end * horizonMs).toISOString();
      return `${STATE_TEXT[segment.state]} until ${formatShortMoment(until, now, timeZone)}`;
    })
    .join(", then ");
}
