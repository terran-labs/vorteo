import { clampPct } from "./format";
import {
  displayBalanceUnit,
  nextReset,
  prepaidBalance,
  PROVIDER_USAGE_DISPLAY_STALE_MS,
  quotaReading,
} from "./quota-reading";
import type {
  ProviderUsage,
  ProviderUsageBalanceUnit,
  ProviderUsageDetail,
  ProviderUsageTone,
  ProviderUsageView,
  ProviderUsageWindow,
} from "./types";

/** One enforced window, drawn as its own bar. */
export interface QuotaWindowRow {
  id: string;
  label: string;
  /** Percent left, or null when the provider omitted it. */
  remaining: number | null;
  resetsAt: string | null;
  /** When the current pace exhausts the window before it resets; null when on track. */
  runsOutAt: string | null;
  /** Code review has its own allowance and never stops ordinary agent work. */
  separate: boolean;
  /** The window that will stop work first, marked only when there is a choice. */
  limiting: boolean;
  /** The provider's own tone for the window, when it sends one. */
  tone: ProviderUsageTone | null;
}

export interface QuotaBalanceRow {
  id: string;
  label: string;
  unit: ProviderUsageBalanceUnit;
  remaining: number | null;
  /** Only balances with a known limit get a bar. */
  limit: number | null;
  resetsAt: string | null;
}

/** One account's quota as the sidebar card shows it. */
export interface QuotaAccount {
  providerId: string;
  name: string;
  plan: string | null;
  source: string | null;
  /** Agents currently running on this account. */
  running: number;
  windows: QuotaWindowRow[];
  balances: QuotaBalanceRow[];
  details: ProviderUsageDetail[];
  /** The limiting window's remaining percent, else a capped balance's, else null. */
  remaining: number | null;
  /** When the limiting window resets, else the account's next known reset. */
  resetsAt: string | null;
  /** Prepaid credit that keeps work going once the plan is spent. */
  credits: number | null;
  /** The reading comes from the account's last limit message, not a live usage source. */
  observed: boolean;
  /** Why usage is missing or old; null when the reading is current. */
  status: string | null;
  failing: boolean;
  disconnected: boolean;
  fetchedAt: string | null;
  /** Failing, nearly out, or on pace to run out before a reset. */
  attention: boolean;
}

/** Remaining below this counts as constrained and sorts with failing accounts. */
export const LOW_QUOTA_PCT = 15;

/**
 * Every account that reports usage or a problem, those needing attention first, then the
 * least remaining. Providers with no usage source and no problem have nothing to show.
 */
export function quotaAccounts(view: ProviderUsageView, now: number): QuotaAccount[] {
  if (view.kind !== "ready") return [];
  const running = view.payload.workerActivity?.runningByProvider ?? {};
  const accounts: QuotaAccount[] = [];
  for (const provider of view.payload.providers) {
    const account = quotaAccount(view, provider, running[provider.providerId] ?? 0, now);
    if (account) accounts.push(account);
  }
  return accounts.sort(compareAccounts);
}

function quotaAccount(
  view: ProviderUsageView,
  provider: ProviderUsage,
  running: number,
  now: number,
): QuotaAccount | null {
  const reading = quotaReading(view, provider.providerId, now);
  const disconnected = Boolean(reading.authRecovery);
  const failing = disconnected || provider.status === "error";
  const windows = windowRows(provider, now);
  const balances = balanceRows(provider);
  if (!failing && provider.status === "unavailable" && !windows.length && !balances.length)
    return null;
  const remaining = limitingRemaining(windows, balances);
  const pacing = windows.some((window) => !window.separate && window.runsOutAt !== null);
  return {
    providerId: provider.providerId,
    name: provider.displayName,
    plan: provider.planLabel ?? null,
    source: provider.sourceLabel ?? null,
    running,
    windows,
    balances,
    details: provider.details ?? [],
    remaining,
    ...runwayInputs(reading, provider),
    status: failing
      ? (reading.statusLabel ?? provider.error ?? "Usage unavailable")
      : healthyStatus(reading, remaining),
    failing,
    disconnected,
    fetchedAt: provider.fetchedAt ?? null,
    attention: failing || pacing || (remaining !== null && remaining < LOW_QUOTA_PCT),
  };
}

/** What the runway lane needs from the shared reading, so the card follows its rules. */
function runwayInputs(
  reading: ReturnType<typeof quotaReading>,
  provider: ProviderUsage,
): Pick<QuotaAccount, "resetsAt" | "credits" | "observed"> {
  return {
    resetsAt: reading.window?.resetsAt ?? nextReset(provider)?.resetsAt ?? null,
    credits: prepaidBalance(provider)?.remaining ?? null,
    observed: reading.observed,
  };
}

/**
 * The shared reading only recognises windows that state a remaining percent, so a window
 * reporting just its used percent must not be called missing here.
 */
function healthyStatus(
  reading: ReturnType<typeof quotaReading>,
  remaining: number | null,
): string | null {
  if (reading.window || remaining === null) return reading.statusLabel;
  return null;
}

/** How many accounts need attention. */
export function attentionCount(accounts: readonly QuotaAccount[]): number {
  return accounts.filter((account) => account.attention).length;
}

function windowRemaining(window: ProviderUsageWindow): number | null {
  let value: number | null = null;
  if (typeof window.remainingPct === "number") value = window.remainingPct;
  else if (typeof window.usedPct === "number") value = 100 - window.usedPct;
  return value !== null && Number.isFinite(value) ? clampPct(value) : null;
}

function windowRows(usage: ProviderUsage, now: number): QuotaWindowRow[] {
  const rows = usage.windows.map((window): QuotaWindowRow => {
    const runsOutAt = window.runsOutAt ?? null;
    return {
      id: window.id,
      label: window.label,
      remaining: windowRemaining(window),
      resetsAt: window.resetsAt ?? null,
      // A projection that has already passed is stale, not a warning.
      runsOutAt: runsOutAt && Date.parse(runsOutAt) > now ? runsOutAt : null,
      separate: window.id === "code_review",
      limiting: false,
      tone: window.tone ?? null,
    };
  });
  const enforced = rows.filter((row) => !row.separate && row.remaining !== null);
  if (enforced.length > 1) {
    const lowest = enforced.reduce((low, row) => (row.remaining! < low.remaining! ? row : low));
    lowest.limiting = true;
  }
  return rows;
}

function balanceRows(usage: ProviderUsage): QuotaBalanceRow[] {
  return (usage.balances ?? []).map((balance) => {
    const limit = typeof balance.limit === "number" && balance.limit > 0 ? balance.limit : null;
    let remaining = typeof balance.remaining === "number" ? balance.remaining : null;
    if (remaining === null && limit !== null && typeof balance.used === "number")
      remaining = limit - balance.used;
    return {
      id: balance.id,
      label: balance.label,
      unit: displayBalanceUnit(usage.providerId, balance),
      remaining,
      limit,
      resetsAt: balance.resetsAt ?? null,
    };
  });
}

function limitingRemaining(
  windows: readonly QuotaWindowRow[],
  balances: readonly QuotaBalanceRow[],
): number | null {
  const enforced = windows.filter((window) => !window.separate && window.remaining !== null);
  if (enforced.length) return Math.min(...enforced.map((window) => window.remaining!));
  const capped = balances.find((balance) => balance.limit !== null && balance.remaining !== null);
  return capped ? clampPct((100 * capped.remaining!) / capped.limit!) : null;
}

function compareAccounts(left: QuotaAccount, right: QuotaAccount): number {
  if (left.failing !== right.failing) return left.failing ? -1 : 1;
  if (left.attention !== right.attention) return left.attention ? -1 : 1;
  const leftRemaining = left.remaining ?? Number.POSITIVE_INFINITY;
  const rightRemaining = right.remaining ?? Number.POSITIVE_INFINITY;
  if (leftRemaining !== rightRemaining) return leftRemaining - rightRemaining;
  return left.name.localeCompare(right.name);
}

export interface QuotaFreshness {
  stale: boolean;
  label: string;
}

/**
 * "Live · 40s ago" while readings are current, "Stale · 12m ago" once they pass the shared
 * display threshold or the last refresh failed.
 */
export function quotaFreshness(view: ProviderUsageView, now: number): QuotaFreshness | null {
  if (view.kind !== "ready") return null;
  const age = now - Date.parse(view.payload.fetchedAt);
  if (!Number.isFinite(age)) return null;
  const stale = age > PROVIDER_USAGE_DISPLAY_STALE_MS || Boolean(view.refreshError);
  return { stale, label: `${stale ? "Stale" : "Live"} · ${formatAge(age)}` };
}

function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
