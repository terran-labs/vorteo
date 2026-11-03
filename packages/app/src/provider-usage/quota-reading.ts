import { formatAmount, formatResetIn } from "./format";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageView,
  ProviderUsageWindow,
} from "./types";

/** How long a fetched reading stays fresh for React Query before a mount refetches it. */
export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;
/**
 * When a reading is labeled "Last known usage". Longer than the daemon cache plus one poll, so
 * a healthy cached reading never crosses it between refreshes.
 */
export const PROVIDER_USAGE_DISPLAY_STALE_MS = 10 * 60 * 1000;
/** Marks a window the daemon derived from the account's last usage-limit message. */
export const LIMIT_OBSERVATION_DETAIL_ID = "claude-limit-observation";

type ReadableWindow = ProviderUsageWindow & { remainingPct: number };

export interface NextReset {
  window: ReadableWindow;
  resetsAt: string;
}

function resetTime(window: ProviderUsageWindow): number | null {
  const time = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return Number.isFinite(time) ? time : null;
}

/** Code review has a separate allowance and must not limit ordinary agent work. */
function readableWindows(usage: ProviderUsage | undefined): ReadableWindow[] {
  if (!usage || usage.authRecovery || usage.status !== "available") return [];
  return usage.windows.filter(
    (window): window is ReadableWindow =>
      window.id !== "code_review" &&
      typeof window.remainingPct === "number" &&
      Number.isFinite(window.remainingPct) &&
      window.remainingPct >= 0 &&
      window.remainingPct <= 100,
  );
}

/** Earliest known reset first; a window without a reset time sorts last. */
function compareResets(left: ProviderUsageWindow, right: ProviderUsageWindow): number {
  const leftTime = resetTime(left) ?? Infinity;
  const rightTime = resetTime(right) ?? Infinity;
  if (leftTime === rightTime) return 0;
  return leftTime < rightTime ? -1 : 1;
}

/** The window with the least left. On a tie, the one that resets soonest. */
export function limitingWindow(usage: ProviderUsage | undefined) {
  const windows = readableWindows(usage).sort(
    (left, right) => left.remainingPct - right.remainingPct || compareResets(left, right),
  );
  return windows[0] ?? null;
}

/** The earliest known reset across the account's windows, excluding code review. */
export function nextReset(usage: ProviderUsage | undefined): NextReset | null {
  const [window] = readableWindows(usage)
    .filter((entry) => resetTime(entry) !== null)
    .sort(compareResets);
  return window?.resetsAt ? { window, resetsAt: window.resetsAt } : null;
}

/** Claude's 5-hour window has no reset time until the first request starts it. */
function isUnstartedSession(window: ReadableWindow): boolean {
  return window.id === "five_hour" && window.remainingPct === 100 && resetTime(window) === null;
}

/** When the limiting window resets, falling back to the account's next known reset. */
export function resetDescription(usage: ProviderUsage | undefined, window: ReadableWindow): string {
  const own = formatResetIn(window.resetsAt);
  if (own) return own === "now" ? "Resetting now" : `Resets ${own}`;
  const next = nextReset(usage);
  const other = next ? formatResetIn(next.resetsAt) : null;
  if (next && other) {
    return other === "now"
      ? `${next.window.label} resetting now`
      : `${next.window.label} resets ${other}`;
  }
  if (isUnstartedSession(window)) return "Session not started";
  return "Reset time unavailable";
}

export function quotaReading(view: ProviderUsageView, providerId: string | undefined, now: number) {
  const usage =
    view.kind === "ready"
      ? view.payload.providers.find((entry) => entry.providerId === providerId)
      : undefined;
  const window = limitingWindow(usage);
  const fetchedAt =
    usage?.fetchedAt ?? (view.kind === "ready" ? view.payload.fetchedAt : undefined);
  const age = fetchedAt ? now - Date.parse(fetchedAt) : NaN;
  const stale = !Number.isFinite(age) || age < 0 || age > PROVIDER_USAGE_DISPLAY_STALE_MS;
  const issue = view.kind === "ready" ? (view.refreshError ?? usage?.refreshError) : undefined;
  let statusLabel: string | null = null;
  if (usage?.authRecovery) statusLabel = "Account disconnected";
  else if (!window) statusLabel = missingUsageLabel(view, usage);
  else if (issue) statusLabel = "Last known usage; refresh unavailable";
  else if (stale) statusLabel = "Last known usage";
  const remaining = window?.remainingPct ?? null;
  const prepaidLabel = prepaidBalanceLabel(usage, remaining);
  const observed = window !== null && isLimitObservation(usage);
  return {
    prepaidLabel,
    observed,
    usage,
    authRecovery: usage?.authRecovery,
    window,
    remaining,
    statusLabel,
  };
}

function isLimitObservation(usage: ProviderUsage | undefined): boolean {
  return Boolean(usage?.details?.some((detail) => detail.id === LIMIT_OBSERVATION_DETAIL_ID));
}

function missingUsageLabel(view: ProviderUsageView, usage: ProviderUsage | undefined): string {
  if (view.kind === "loading") return "Loading usage";
  if (usage?.details?.some((detail) => detail.id === "claude-setup-token")) {
    return "Usage not provided";
  }
  return "Usage unavailable";
}

function prepaidBalanceLabel(
  usage: ProviderUsage | undefined,
  remaining: number | null,
): string | null {
  if (!usage || remaining !== 0) return null;
  const balance = prepaidBalance(usage);
  if (balance) {
    const unit = displayBalanceUnit(usage.providerId, balance);
    const label = unit === "usd" ? "credit" : unit;
    const amount =
      unit === "tokens"
        ? balance.remaining.toLocaleString()
        : formatAmount(balance.remaining, unit);
    return `${amount} ${label} left`;
  }
  return null;
}

/** A positive balance other than requests, which keeps work going once the plan is spent. */
export function prepaidBalance(
  usage: ProviderUsage | undefined,
): (ProviderUsageBalance & { remaining: number }) | null {
  const balance = usage?.balances?.find(
    (entry): entry is ProviderUsageBalance & { remaining: number } =>
      entry.unit !== "requests" &&
      typeof entry.remaining === "number" &&
      Number.isFinite(entry.remaining) &&
      entry.remaining > 0,
  );
  return balance ?? null;
}

/** The unit to show a balance in, correcting daemons that reported Codex credits as dollars. */
export function displayBalanceUnit(
  providerId: string,
  balance: Pick<ProviderUsageBalance, "id" | "unit">,
): ProviderUsageBalance["unit"] {
  // COMPAT(codexCreditUnit): added in v0.11.0-beta.3.vorteo.165; remove after 2027-04-07 once daemon floor includes the credit-unit correction.
  const legacyCodexCredits =
    (providerId === "codex" || providerId.startsWith("codex-")) &&
    balance.id === "credits" &&
    balance.unit === "usd";
  return legacyCodexCredits ? "credits" : balance.unit;
}
