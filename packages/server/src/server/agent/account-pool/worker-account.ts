import {
  AccountQuotaPolicyV1Schema,
  type AccountQuotaPolicy,
} from "@getpaseo/protocol/account-quota-policy";
import { installationProviderReference } from "@getpaseo/protocol/installation-settings";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
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
  requireMeasured?: boolean;
  reservedHeadroomPct?: number;
  capacityByProvider?: Readonly<Record<string, WorkerAccountCapacity>>;
  deprioritizeProviders?: readonly string[];
  /** Definition IDs established by installation settings, keyed by destination-local ID. */
  installationDefinitionByProvider?: Readonly<Record<string, string>>;
}

interface WorkerAccountCapacity {
  cap: number;
  current: number;
}

interface WorkerAccountWindow {
  id: string;
  remainingPct: number | null;
  resetsAt: string | null;
}

type ExclusionReason =
  | "disabled"
  | "not-ready"
  | "wrong-provider-type"
  | "avoided"
  | "automatic-opt-out"
  | "signed-out"
  | "outside-pool"
  | "quota-policy-unresolved"
  | "invalid-reservation"
  | "quota-below-floor"
  | "usage-limit-hold"
  | "measurement-required"
  | "capacity-reached"
  | "invalid-capacity";

export interface WorkerAccountCandidate {
  provider: string;
  installationDefinitionId: string | null;
  accountRef: string;
  eligibility: "eligible" | "known-low" | "unreadable" | "ineligible";
  windows: WorkerAccountWindow[];
  floorPct: number | null;
  reservedHeadroomPct: number | null;
  remainingPct: number | null;
  capacity: WorkerAccountCapacity | null;
  readingAgeMs: number | null;
  exclusionReason: ExclusionReason | null;
  earliestResetAt: string | null;
}

export type WorkerAccountPick = { candidates: WorkerAccountCandidate[] } & (
  | {
      provider: string;
      reason: "known-headroom" | "default-usage-unreadable" | "alternate-usage-unreadable";
      earliestResetAt: null;
      droppedLowProviders?: string[];
    }
  | {
      provider: null;
      reason:
        | "no-eligible-account"
        | "quota-below-floor"
        | "quota-policy-unresolved"
        | "invalid-reservation"
        | "no-capacity"
        | "measurement-required";
      earliestResetAt: string | null;
    }
);

/** Uses destination-local usage, readiness and settings for admission and recovery. */
export async function pickWorkerAccount(input: WorkerAccountInput): Promise<WorkerAccountPick> {
  const parsed = AccountQuotaPolicyV1Schema.safeParse(input.settings.accountQuotaPolicy);
  const policy = parsed.success ? parsed.data : null;
  const invalidPolicy = Boolean(input.settings.accountQuotaPolicy && !policy);
  const reservation = input.reservedHeadroomPct ?? 0;
  const context = await accountContext(input, policy, reservation);
  const entries = new Map(input.ready.map((entry) => [entry.provider, entry]));
  for (const provider of Object.keys(input.installationDefinitionByProvider ?? {})) {
    if (!entries.has(provider))
      entries.set(provider, { provider, enabled: true, status: "unavailable" });
  }
  const candidates = [...entries.values()].map((entry) => assessAccount(input, context, entry));
  candidates.sort((a, b) => compareAccounts(a, b, input.defaultProvider, context.deprioritized));

  if (invalidPolicy) return refusal("quota-policy-unresolved", candidates, null);
  if (context.reservation === null) return refusal("invalid-reservation", candidates, null);
  const low = candidates.filter(({ eligibility }) => eligibility === "known-low");
  const chosen = candidates.find(({ exclusionReason }) => exclusionReason === null);
  if (chosen?.eligibility === "eligible") {
    return {
      provider: chosen.provider,
      reason: "known-headroom",
      earliestResetAt: null,
      candidates,
    };
  }
  if (chosen) {
    const droppedLowProviders = [...new Set(low.map(({ provider }) => provider))];
    return {
      provider: chosen.provider,
      reason:
        chosen.provider === input.defaultProvider
          ? "default-usage-unreadable"
          : "alternate-usage-unreadable",
      earliestResetAt: null,
      candidates,
      ...(droppedLowProviders.length > 0 ? { droppedLowProviders } : {}),
    };
  }
  return parkedAccount(candidates, low);
}

type BlockedReason = Extract<WorkerAccountPick, { provider: null }>["reason"];

function refusal(
  reason: BlockedReason,
  candidates: WorkerAccountCandidate[],
  earliestResetAt: string | null,
): WorkerAccountPick {
  return { provider: null, reason, earliestResetAt, candidates };
}

function parkedAccount(candidates: WorkerAccountCandidate[], low: WorkerAccountCandidate[]) {
  const reasons = new Set(candidates.map(({ exclusionReason }) => exclusionReason));
  if (reasons.has("quota-policy-unresolved"))
    return refusal("quota-policy-unresolved", candidates, null);
  if (reasons.has("capacity-reached") || reasons.has("invalid-capacity"))
    return refusal("no-capacity", candidates, null);
  if (reasons.has("measurement-required")) return refusal("measurement-required", candidates, null);
  if (low.length) {
    const resets = low.flatMap(({ earliestResetAt }) => earliestResetAt ?? []).sort();
    return refusal("quota-below-floor", candidates, resets[0] ?? null);
  }
  return refusal("no-eligible-account", candidates, null);
}

const eligibilityOrder = { eligible: 0, unreadable: 1, "known-low": 2, ineligible: 3 } as const;

function compareAccounts(
  a: WorkerAccountCandidate,
  b: WorkerAccountCandidate,
  defaultProvider: string | null,
  deprioritized: ReadonlySet<string>,
): number {
  const byEligibility = eligibilityOrder[a.eligibility] - eligibilityOrder[b.eligibility];
  if (byEligibility) return byEligibility;
  if (a.eligibility === "eligible") {
    const byPreference =
      Number(deprioritized.has(a.provider)) - Number(deprioritized.has(b.provider));
    const byQuota = (b.remainingPct ?? 0) - (a.remainingPct ?? 0);
    if (byPreference || byQuota) return byPreference || byQuota;
  }
  return Number(b.provider === defaultProvider) - Number(a.provider === defaultProvider);
}

interface WorkerAccountContext {
  policy: AccountQuotaPolicy | null;
  reservation: number | null;
  accountRef(provider: string): string;
  optedOut(provider: string): boolean;
  avoided: ReadonlySet<string>;
  deprioritized: ReadonlySet<string>;
  signedOut: ReadonlySet<string>;
  heldUntil: ReadonlyMap<string, number>;
}

async function accountContext(
  input: WorkerAccountInput,
  policy: AccountQuotaPolicy | null,
  reservation: number,
): Promise<WorkerAccountContext> {
  const { settings, ready, usage } = input;
  const avoided = input.avoidProvider ? [input.avoidProvider] : [];
  const deprioritized = input.deprioritizeProviders ?? [];
  const holds = activeUsageHolds(input);
  const aliases = [...avoided, ...deprioritized, ...holds.keys()];
  const homes = await resolveLaunchHomes(ready, settings, undefined, aliases);
  const accountRef = (provider: string) =>
    installationProviderReference(provider, settings.providers);
  function matching(providers: readonly string[]): Set<string> {
    const references = new Set(providers.map(accountRef));
    const matchingHomes = new Set(providers.flatMap((provider) => homes.get(provider) ?? []));
    const definitions = new Set(
      providers.flatMap((provider) => definitionId(input, provider) ?? []),
    );
    const matched = ready.filter(({ provider }) => {
      const home = homes.get(provider);
      const definition = definitionId(input, provider);
      return (
        references.has(accountRef(provider)) ||
        (home != null && matchingHomes.has(home)) ||
        (definition !== null && definitions.has(definition))
      );
    });
    return new Set(matched.map(({ provider }) => provider));
  }
  const heldUntil = new Map<string, number>();
  for (const [provider, reset] of holds) {
    for (const alias of matching([provider])) {
      heldUntil.set(alias, Math.max(reset, heldUntil.get(alias) ?? 0));
    }
  }
  return {
    policy,
    reservation: pct(reservation),
    accountRef,
    optedOut: automaticPlacementExclusions(settings, homes),
    avoided: matching(avoided),
    deprioritized: matching(deprioritized),
    signedOut: new Set(classifyProviders(ready, usage.providers).signedOut),
    heldUntil,
  };
}

function activeUsageHolds(input: WorkerAccountInput): Map<string, number> {
  const holds = new Map<string, number>();
  for (const [provider, until] of Object.entries(input.usageLimitedUntilByProvider ?? {})) {
    const reset = Date.parse(until ?? "");
    if (reset > input.nowMs) holds.set(provider, reset);
  }
  return holds;
}

function definitionId(input: WorkerAccountInput, provider: string): string | null {
  const definitions = input.installationDefinitionByProvider;
  return definitions && Object.hasOwn(definitions, provider) ? definitions[provider] : null;
}

type ProviderEntry = WorkerAccountInput["ready"][number];

function accountExclusion(
  input: WorkerAccountInput,
  context: WorkerAccountContext,
  entry: ProviderEntry,
  accountRef: string,
): ExclusionReason | null {
  const { provider } = entry;
  if (!entry.enabled) return "disabled";
  if (entry.status !== "ready") return "not-ready";
  if (context.avoided.has(provider)) return "avoided";
  if (context.optedOut(provider)) return "automatic-opt-out";
  if (context.signedOut.has(provider)) return "signed-out";
  if (safeProviderType(provider, input.settings) !== input.providerType)
    return "wrong-provider-type";
  const pool = context.policy?.accounts;
  if (pool && Object.hasOwn(pool, accountRef) && pool[accountRef].pool === false)
    return "outside-pool";
  return null;
}

function assessAccount(
  input: WorkerAccountInput,
  context: WorkerAccountContext,
  entry: ProviderEntry,
): WorkerAccountCandidate {
  const { provider } = entry;
  const accountRef = context.accountRef(provider);
  const invalidPolicy = input.settings.accountQuotaPolicy && !context.policy;
  const floor = invalidPolicy ? null : resolveFloor(context.policy, accountRef, input.priority);
  const evidence = usageEvidence(input, provider);
  const capacity = providerCapacity(input.capacityByProvider, provider);
  const exclusion = accountExclusion(input, context, entry, accountRef);
  const candidate: WorkerAccountCandidate = {
    provider,
    installationDefinitionId: definitionId(input, provider),
    accountRef,
    eligibility: "ineligible",
    ...evidence,
    floorPct: floor?.floorPct ?? null,
    reservedHeadroomPct: context.reservation,
    capacity: capacity.value,
    exclusionReason: exclusion,
  };
  if (exclusion) return candidate;
  if (!floor) return { ...candidate, floorPct: null, exclusionReason: "quota-policy-unresolved" };
  if (context.reservation === null) return { ...candidate, exclusionReason: "invalid-reservation" };
  return assessQuota({
    input,
    candidate,
    threshold: floor.floorPct + context.reservation,
    capacityReason: capacity.reason,
    heldUntil: context.heldUntil.get(provider) ?? 0,
  });
}

interface QuotaAssessment {
  input: WorkerAccountInput;
  candidate: WorkerAccountCandidate;
  threshold: number;
  capacityReason: ExclusionReason | null;
  heldUntil: number;
}

function assessQuota({
  input,
  candidate,
  threshold,
  capacityReason,
  heldUntil,
}: QuotaAssessment): WorkerAccountCandidate {
  const { provider, accountRef, readingAgeMs, windows } = candidate;
  const floor = evaluateFloor({
    accountRef,
    providerId: provider,
    priority: input.priority,
    policy: input.settings.accountQuotaPolicy,
    usage: input.usage,
    nowMs: input.nowMs,
    limitHold: heldUntil > 0,
  });
  const fresh =
    readingAgeMs !== null && readingAgeMs >= 0 && readingAgeMs <= ACCOUNT_READING_MAX_AGE_MS;
  const blocking = fresh
    ? windows.filter(({ remainingPct }) => remainingPct !== null && remainingPct <= threshold)
    : [];
  const measuredLow = blocking.length > 0 && candidate.remainingPct !== null;
  if (heldUntil > 0 || measuredLow) {
    const resets = blocking.map(({ resetsAt }) => Date.parse(resetsAt ?? ""));
    const allResetsKnown = resets.length > 0 && resets.every((time) => time > input.nowMs);
    const windowReset = allResetsKnown ? Math.max(...resets) : 0;
    const reset = Math.max(heldUntil, windowReset);
    return {
      ...candidate,
      eligibility: "known-low",
      exclusionReason: heldUntil > 0 ? "usage-limit-hold" : "quota-below-floor",
      earliestResetAt: reset > 0 ? new Date(reset).toISOString() : null,
    };
  }
  if (capacityReason) return { ...candidate, exclusionReason: capacityReason };
  if (floor.kind === "above-floor") {
    return { ...candidate, eligibility: "eligible" };
  }
  if (input.requireMeasured) {
    return { ...candidate, eligibility: "unreadable", exclusionReason: "measurement-required" };
  }
  return { ...candidate, eligibility: "unreadable" };
}

function pct(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function usageEvidence(
  { usage, nowMs }: WorkerAccountInput,
  provider: string,
): Pick<WorkerAccountCandidate, "windows" | "remainingPct" | "readingAgeMs" | "earliestResetAt"> {
  const reading = usage.providers.find(({ providerId }) => providerId === provider);
  const fetchedAt = reading ? Date.parse(reading.fetchedAt ?? usage.fetchedAt) : NaN;
  const readingAgeMs = Number.isFinite(fetchedAt) ? nowMs - fetchedAt : null;
  const windows =
    reading?.windows.map(({ id, remainingPct, usedPct, resetsAt }) => {
      const reset = Date.parse(resetsAt ?? "");
      return {
        id,
        remainingPct: pct(remainingPct ?? (usedPct === 100 ? 0 : null)),
        resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
      };
    }) ?? [];
  const fresh =
    readingAgeMs !== null && readingAgeMs >= 0 && readingAgeMs <= ACCOUNT_READING_MAX_AGE_MS;
  const measured = windows.flatMap(({ remainingPct }) => remainingPct ?? []);
  const remainingPct =
    fresh && reading?.status === "available" && measured.length ? Math.min(...measured) : null;
  const resets = windows.flatMap(({ resetsAt }) => resetsAt ?? []).sort();
  return { windows, remainingPct, readingAgeMs, earliestResetAt: resets[0] ?? null };
}

function providerCapacity(
  capacities: WorkerAccountInput["capacityByProvider"],
  provider: string,
): { value: WorkerAccountCapacity | null; reason: ExclusionReason | null } {
  if (!capacities || !Object.hasOwn(capacities, provider)) return { value: null, reason: null };
  const { cap, current } = capacities[provider];
  const validCap = Number.isSafeInteger(cap) && cap >= 0;
  const validCurrent = Number.isSafeInteger(current) && current >= 0;
  if (!validCap || !validCurrent) return { value: null, reason: "invalid-capacity" };
  return { value: { cap, current }, reason: current >= cap ? "capacity-reached" : null };
}
