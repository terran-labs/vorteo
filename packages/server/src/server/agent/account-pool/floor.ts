import {
  ACCOUNT_QUOTA_POLICY_VERSION,
  BUILT_IN_QUOTA_FLOORS,
  isQuotaFloor,
  type AccountQuotaPolicyWire,
} from "@getpaseo/protocol/account-quota-policy";

import { rankAccounts, type UsageList } from "../../factory/project/account-choice.js";

/**
 * Pure quota floor evaluation (#518 slice 6). Nothing calls this yet: admission, launch, switch
 * and pause paths behave as before. A floor is the percent of every usage window an account must
 * keep for a given priority; the binding window is whichever has the least remaining now.
 *
 * Freshness and window validity come from Factory account choice (`rankAccounts`), so both
 * agree on what counts as a usable reading. A stale reading is unmeasured; no grace period.
 * Two checks are added here without changing account choice: a reading dated after `nowMs`
 * and a remaining percentage outside 0 to 100 are unmeasured too.
 *
 * The policy is read as stored, so every value is checked here: a policy of another version is
 * unusable, and malformed entries never count as a floor.
 */

type Policy = AccountQuotaPolicyWire | null | undefined;

export type FloorSource = "account" | "ladder" | "built-in";

export type FloorEvaluation =
  | {
      kind: "above-floor" | "below-floor";
      floorPct: number;
      floorSource: FloorSource;
      /** The window with the least remaining. */
      bindingWindowId: string;
      remainingPct: number;
      /** Below floor, but the owner placed this thread here and may go below it. */
      ownerPlacementExempt: boolean;
      pool: boolean | null;
    }
  | {
      /** The floor cannot be enforced here; say so rather than guess. */
      kind: "unmeasured";
      reason: "no-reading" | "unreadable" | "stale" | "future-dated" | "out-of-range";
      floorPct: number;
      floorSource: FloorSource;
      pool: boolean | null;
    }
  | {
      /** A usage limit is recorded or a window has nothing left. */
      kind: "limited";
      bindingWindowId: string | null;
      pool: boolean | null;
    }
  | {
      /** The policy names no usable floor for this priority. */
      kind: "unresolved";
      reason: "unknown-priority" | "invalid-floor";
      pool: boolean | null;
    }
  | {
      /** The stored policy is a version this daemon cannot read; nothing in it is used. */
      kind: "unresolved";
      reason: "unsupported-version";
      version: number;
      pool: null;
    };

/**
 * `accountRef` and `providerId` must name the same account: the caller derives `accountRef`
 * from `providerId` with `installationProviderReference` and that daemon's provider config.
 * Nothing here can check that. Mismatched inputs apply one account's policy row to another's
 * reading; a `providerId` with no reading in `usage` yields unmeasured.
 */
export interface FloorInput {
  /** `installationProviderReference(providerId, providers)`; keys `policy.accounts`. */
  accountRef: string;
  /** The local provider id whose reading is in `usage`. */
  providerId: string;
  priority: string;
  /** The stored policy. Absent: built-in ladder, pool membership unstated. */
  policy?: Policy;
  usage: UsageList;
  nowMs: number;
  /** A usage-limit hold is recorded for the account, whatever its reading says. */
  limitHold?: boolean;
  /** The owner placed this thread on the account. */
  ownerPlaced?: boolean;
}

/**
 * The floor for a priority: the account's override, else the policy ladder, else the built-in
 * ladder. The first level that names the priority decides; a malformed value there is invalid,
 * never silently replaced by a lower level.
 */
export function resolveFloor(
  policy: Policy,
  accountRef: string,
  priority: string,
): { floorPct: number; source: FloorSource } | { invalid: true } | null {
  const levels: [FloorSource, Record<string, unknown> | undefined][] = [
    ["account", record(accountRow(policy, accountRef)?.floors)],
    ["ladder", record(policy?.ladder)],
    ["built-in", BUILT_IN_QUOTA_FLOORS],
  ];
  for (const [source, floors] of levels) {
    if (!floors || !Object.hasOwn(floors, priority)) continue;
    const value = floors[priority];
    return isQuotaFloor(value) ? { floorPct: value, source } : { invalid: true };
  }
  return null;
}

export function evaluateFloor(input: FloorInput): FloorEvaluation {
  const reading = input.usage.providers.find((item) => item.providerId === input.providerId);
  const lowest = lowestWindow(reading?.windows ?? []);
  const { policy } = input;
  if (policy && policy.version !== ACCOUNT_QUOTA_POLICY_VERSION)
    return {
      kind: "unresolved",
      reason: "unsupported-version",
      version: policy.version,
      pool: null,
    };
  const pool = poolMembership(policy, input.accountRef);

  if (input.limitHold) return { kind: "limited", bindingWindowId: lowest?.id ?? null, pool };

  const floor = resolveFloor(policy, input.accountRef, input.priority);
  if (floor === null) return { kind: "unresolved", reason: "unknown-priority", pool };
  if ("invalid" in floor) return { kind: "unresolved", reason: "invalid-floor", pool };
  const { floorPct, source: floorSource } = floor;

  const unusable = readingProblem(reading, input.usage, input.nowMs);
  if (unusable) return { kind: "unmeasured", reason: unusable, floorPct, floorSource, pool };

  const [judged] = rankAccounts({
    candidates: [input.providerId],
    usage: input.usage,
    nowMs: input.nowMs,
  }).considered;
  switch (judged?.verdict) {
    case "stale":
      return { kind: "unmeasured", reason: "stale", floorPct, floorSource, pool };
    case "exhausted":
      return { kind: "limited", bindingWindowId: lowest?.id ?? null, pool };
    case "qualifies":
      break;
    default:
      return {
        kind: "unmeasured",
        reason: reading ? "unreadable" : "no-reading",
        floorPct,
        floorSource,
        pool,
      };
  }
  // `qualifies` guarantees at least one window and all finite percentages.
  const remainingPct = judged.remainingPct!;
  const below = remainingPct < floorPct;
  return {
    kind: below ? "below-floor" : "above-floor",
    floorPct,
    floorSource,
    bindingWindowId: lowest!.id,
    remainingPct,
    ownerPlacementExempt: below && input.ownerPlaced === true,
    pool,
  };
}

/** The owner's stated pool membership, or null when the policy does not say. */
function poolMembership(policy: Policy, accountRef: string) {
  const value = accountRow(policy, accountRef)?.pool;
  return typeof value === "boolean" ? value : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function accountRow(policy: Policy, accountRef: string): Record<string, unknown> | undefined {
  const accounts = record(policy?.accounts);
  return accounts && Object.hasOwn(accounts, accountRef) ? record(accounts[accountRef]) : undefined;
}

/** Checks account choice does not make: a reading from the future, or a percentage out of range. */
function readingProblem(
  reading: UsageList["providers"][number] | undefined,
  usage: UsageList,
  nowMs: number,
): "future-dated" | "out-of-range" | null {
  if (!reading) return null;
  const fetchedAt = Date.parse(reading.fetchedAt ?? usage.fetchedAt);
  if (Number.isFinite(fetchedAt) && fetchedAt > nowMs) return "future-dated";
  const outOfRange = reading.windows.some(
    ({ remainingPct: value }) =>
      typeof value === "number" && Number.isFinite(value) && (value < 0 || value > 100),
  );
  return outOfRange ? "out-of-range" : null;
}

function lowestWindow(
  windows: readonly { id: string; remainingPct?: number | null }[],
): { id: string } | null {
  let lowest: { id: string; remainingPct: number } | null = null;
  for (const window of windows) {
    const value = window.remainingPct;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (lowest === null || value < lowest.remainingPct)
      lowest = { id: window.id, remainingPct: value };
  }
  return lowest;
}
