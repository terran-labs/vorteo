import { AccountQuotaPolicyV1Schema } from "@getpaseo/protocol/account-quota-policy";
import { installationProviderReference } from "@getpaseo/protocol/installation-settings";
import type { MutableDaemonConfig, ProviderUsage } from "@getpaseo/protocol/messages";
import {
  ACCOUNT_READING_MAX_AGE_MS,
  type UsageList,
} from "../../factory/project/account-choice.js";
import {
  automaticPlacementExclusions,
  classifyProviders,
  resolveLaunchHomes,
  safeProviderType,
} from "../../system-project/launch-selection.js";
import type { ProviderSnapshotEntry } from "../agent-sdk-types.js";
import { evaluateFloor, resolveFloor } from "./floor.js";

export interface WorkerAccountInput {
  settings: MutableDaemonConfig;
  ready: readonly Pick<ProviderSnapshotEntry, "provider" | "enabled" | "status">[];
  usage: UsageList;
  providerType: string;
  defaultProvider: string | null;
  priority: string;
  nowMs: number;
  /** The account that just stopped, including its aliases on this daemon. */
  avoidProvider?: string;
  /** Account stop expiries from the daemon's live and saved usage-limit holds. */
  usageLimitedUntilByProvider?: Readonly<Record<string, string | null>>;
}

export type WorkerAccountPick =
  | {
      provider: string;
      reason: "known-headroom" | "default-usage-unreadable" | "alternate-usage-unreadable";
      earliestResetAt: null;
      droppedLowProviders?: string[];
    }
  | {
      provider: null;
      reason: "no-eligible-account" | "quota-below-floor" | "quota-policy-unresolved";
      earliestResetAt: string | null;
    };

/** Uses destination-local usage, readiness and settings for both admission and recovery. */
export async function pickWorkerAccount(input: WorkerAccountInput): Promise<WorkerAccountPick> {
  const candidates = await eligibleWorkerAccounts(input);
  const policy = input.settings.accountQuotaPolicy;
  if (policy && !AccountQuotaPolicyV1Schema.safeParse(policy).success)
    return { provider: null, reason: "quota-policy-unresolved", earliestResetAt: null };
  const ranked = candidates.map(({ provider, reference, heldUntil }) =>
    assessAccount(input, provider, reference, heldUntil),
  );
  const best = ranked
    .filter((entry) => entry.kind === "above-floor")
    .sort((left, right) => {
      const byQuota = right.remainingPct - left.remainingPct;
      const byDefault =
        Number(right.provider === input.defaultProvider) -
        Number(left.provider === input.defaultProvider);
      return byQuota || byDefault;
    })[0];
  if (best) return { provider: best.provider, reason: "known-headroom", earliestResetAt: null };
  const low = ranked.filter((entry) => entry.kind === "below-floor");
  if (ranked.some((entry) => entry.kind === "unresolved"))
    return { provider: null, reason: "quota-policy-unresolved", earliestResetAt: null };
  const unreadable = ranked.filter((entry) => entry.kind === "unmeasured");
  const preferred = unreadable.find(({ provider }) => provider === input.defaultProvider);
  const fallback = preferred ?? unreadable[0];
  if (fallback) {
    const droppedLowProviders = [...new Set(low.map(({ provider }) => provider))];
    return {
      provider: fallback.provider,
      reason: preferred ? "default-usage-unreadable" : "alternate-usage-unreadable",
      earliestResetAt: null,
      ...(droppedLowProviders.length > 0 ? { droppedLowProviders } : {}),
    };
  }
  if (low.length) {
    const earliestReset = Math.min(...low.map(({ reset }) => reset));
    const earliestResetAt = Number.isFinite(earliestReset)
      ? new Date(earliestReset).toISOString()
      : null;
    return { provider: null, reason: "quota-below-floor", earliestResetAt };
  }
  return { provider: null, reason: "no-eligible-account", earliestResetAt: null };
}

async function eligibleWorkerAccounts(input: WorkerAccountInput) {
  const { settings, usage, avoidProvider } = input;
  const ready = input.ready.filter(({ enabled, status }) => enabled && status === "ready");
  const avoid = avoidProvider ? [avoidProvider] : [];
  const holds = activeUsageHolds(input);
  const homes = await resolveLaunchHomes(ready, settings, undefined, [...avoid, ...holds.keys()]);
  const excluded = automaticPlacementExclusions(settings, homes, avoid);
  const { signedOut } = classifyProviders(ready, usage.providers);
  const signedOutIds = new Set(signedOut);
  const accountRef = (provider: string) =>
    installationProviderReference(provider, settings.providers);
  const stoppedRef = avoidProvider ? accountRef(avoidProvider) : null;
  const policy = AccountQuotaPolicyV1Schema.safeParse(settings.accountQuotaPolicy);
  const pool = policy.success ? policy.data.accounts : {};
  return ready.flatMap(({ provider }) => {
    if (excluded(provider) || signedOutIds.has(provider)) return [];
    if (safeProviderType(provider, settings) !== input.providerType) return [];
    const reference = accountRef(provider);
    if (reference === stoppedRef) return [];
    if (Object.hasOwn(pool, reference) && pool[reference].pool === false) return [];
    const home = homes.get(provider);
    let heldUntil = 0;
    for (const [heldProvider, reset] of holds) {
      const sameReference = accountRef(heldProvider) === reference;
      const sameHome = home != null && homes.get(heldProvider) === home;
      if (sameReference || sameHome) heldUntil = Math.max(heldUntil, reset);
    }
    return [{ provider, reference, heldUntil }];
  });
}

function activeUsageHolds(input: WorkerAccountInput): Map<string, number> {
  const holds = new Map<string, number>();
  for (const [provider, until] of Object.entries(input.usageLimitedUntilByProvider ?? {})) {
    const reset = Date.parse(until ?? "");
    if (reset > input.nowMs) holds.set(provider, reset);
  }
  return holds;
}

type AccountAssessment =
  | { kind: "above-floor"; provider: string; remainingPct: number }
  | { kind: "below-floor"; provider: string; reset: number }
  | { kind: "unresolved" | "unmeasured"; provider: string };

function assessAccount(
  input: WorkerAccountInput,
  provider: string,
  reference: string,
  heldUntil: number,
): AccountAssessment {
  const { usage, settings, nowMs, priority } = input;
  const floor = evaluateFloor({
    accountRef: reference,
    providerId: provider,
    priority,
    policy: settings.accountQuotaPolicy,
    usage,
    nowMs,
    limitHold: heldUntil > 0,
  });
  if (floor.kind === "unresolved") return { kind: "unresolved", provider };
  if (floor.kind === "above-floor" && floor.remainingPct > floor.floorPct)
    return { kind: "above-floor", provider, remainingPct: floor.remainingPct };
  const policy = AccountQuotaPolicyV1Schema.safeParse(settings.accountQuotaPolicy);
  const threshold = resolveFloor(policy.success ? policy.data : null, reference, priority);
  const reading = usage.providers.find(({ providerId }) => providerId === provider);
  const blocking = blockingWindows(reading, usage.fetchedAt, nowMs, threshold?.floorPct ?? 0);
  if (floor.kind === "unmeasured" && !blocking.length) return { kind: "unmeasured", provider };
  // One account may have to wait for several windows. An unknown reset gives no deadline.
  const resets = blocking.map(({ resetsAt }) => Date.parse(resetsAt ?? ""));
  const allResetsKnown = resets.length > 0 && resets.every((value) => value > nowMs);
  const windowReset = allResetsKnown ? Math.max(...resets) : 0;
  const reset = Math.max(heldUntil, windowReset) || Infinity;
  return { kind: "below-floor", provider, reset };
}

/** A known low window still blocks when another window in the reading is missing. */
function blockingWindows(
  reading: ProviderUsage | undefined,
  listFetchedAt: string,
  nowMs: number,
  floorPct: number,
): ProviderUsage["windows"] {
  if (!reading || reading.status !== "available") return [];
  const age = nowMs - Date.parse(reading.fetchedAt ?? listFetchedAt);
  if (!Number.isFinite(age) || age < 0 || age > ACCOUNT_READING_MAX_AGE_MS) return [];
  return reading.windows.filter(({ remainingPct, usedPct }) => {
    if (typeof remainingPct !== "number") return usedPct === 100;
    return remainingPct >= 0 && remainingPct <= floorPct;
  });
}
