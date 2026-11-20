import {
  ACCOUNT_QUOTA_POLICY_VERSION,
  AccountQuotaPolicyV1Schema,
  BUILT_IN_QUOTA_FLOORS,
  type AccountQuotaPolicy,
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
 * Order: a recorded limit hold or an exhausted window is reported as limited whatever the policy
 * says. Then the stored policy must be version 1 and pass the same strict schema a patch must,
 * or the result is unresolved: a hand-edited file never falls through to a weaker floor.
 */

export type FloorSource = "account" | "ladder" | "built-in";

type UnmeasuredReason = "no-reading" | "unreadable" | "stale" | "future-dated" | "out-of-range";

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
      reason: UnmeasuredReason;
      floorPct: number;
      floorSource: FloorSource;
      pool: boolean | null;
    }
  | {
      /** A usage limit is recorded or a window has nothing left. */
      kind: "limited";
      bindingWindowId: string | null;
    }
  | {
      /** The policy names no floor for this priority. */
      kind: "unresolved";
      reason: "unknown-priority";
      pool: boolean | null;
    }
  | {
      /** The stored policy cannot be used; nothing in it applies. */
      kind: "unresolved";
      reason: "unsupported-version" | "invalid-policy";
      version: number;
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
  /** The stored policy, as read. Absent: built-in ladder, pool membership unstated. */
  policy?: AccountQuotaPolicyWire | null;
  usage: UsageList;
  nowMs: number;
  /** A usage-limit hold is recorded for the account, whatever its reading says. */
  limitHold?: boolean;
  /** The owner placed this thread on the account. */
  ownerPlaced?: boolean;
}

/** The floor for a priority: the account's override, else the policy ladder, else built-in. */
export function resolveFloor(
  policy: AccountQuotaPolicy | null,
  accountRef: string,
  priority: string,
): { floorPct: number; source: FloorSource } | null {
  const levels: [FloorSource, Readonly<Record<string, number>> | undefined][] = [
    ["account", accountRow(policy, accountRef)?.floors],
    ["ladder", policy?.ladder],
    ["built-in", BUILT_IN_QUOTA_FLOORS],
  ];
  for (const [source, floors] of levels)
    if (floors && Object.hasOwn(floors, priority)) return { floorPct: floors[priority], source };
  return null;
}

export function evaluateFloor(input: FloorInput): FloorEvaluation {
  const reading = input.usage.providers.find((item) => item.providerId === input.providerId);
  const lowestId = lowestWindow(reading?.windows ?? [])?.id ?? null;
  const problem = readingProblem(reading, input.usage, input.nowMs);
  const [judged] = rankAccounts({
    candidates: [input.providerId],
    usage: input.usage,
    nowMs: input.nowMs,
  }).considered;
  if (input.limitHold || (!problem && judged?.verdict === "exhausted"))
    return { kind: "limited", bindingWindowId: lowestId };

  const parsed = readPolicy(input.policy);
  if ("unusable" in parsed)
    return { kind: "unresolved", reason: parsed.unusable, version: parsed.version };
  const { policy } = parsed;
  const pool = accountRow(policy, input.accountRef)?.pool ?? null;

  const floor = resolveFloor(policy, input.accountRef, input.priority);
  if (floor === null) return { kind: "unresolved", reason: "unknown-priority", pool };
  const { floorPct, source: floorSource } = floor;
  const reason = unmeasuredReason(problem, judged?.verdict, reading !== undefined);
  if (reason) return { kind: "unmeasured", reason, floorPct, floorSource, pool };
  // `qualifies` guarantees at least one window and all finite percentages.
  const remainingPct = judged!.remainingPct!;
  const below = remainingPct < floorPct;
  return {
    kind: below ? "below-floor" : "above-floor",
    floorPct,
    floorSource,
    bindingWindowId: lowestId!,
    remainingPct,
    ownerPlacementExempt: below && input.ownerPlaced === true,
    pool,
  };
}

/** Why a reading cannot be measured against a floor, or null when it qualifies. */
function unmeasuredReason(
  problem: "future-dated" | "out-of-range" | null,
  verdict: string | undefined,
  hasReading: boolean,
): UnmeasuredReason | null {
  if (problem) return problem;
  if (verdict === "qualifies") return null;
  if (verdict === "stale") return "stale";
  return hasReading ? "unreadable" : "no-reading";
}

/** The stored policy in the version 1 shape, or why it cannot be used. Absent is usable. */
function readPolicy(
  policy: AccountQuotaPolicyWire | null | undefined,
):
  | { policy: AccountQuotaPolicy | null }
  | { unusable: "unsupported-version" | "invalid-policy"; version: number } {
  if (!policy) return { policy: null };
  if (policy.version !== ACCOUNT_QUOTA_POLICY_VERSION)
    return { unusable: "unsupported-version", version: policy.version };
  const parsed = AccountQuotaPolicyV1Schema.safeParse(policy);
  return parsed.success
    ? { policy: parsed.data }
    : { unusable: "invalid-policy", version: policy.version };
}

function accountRow(policy: AccountQuotaPolicy | null, accountRef: string) {
  return policy && Object.hasOwn(policy.accounts, accountRef)
    ? policy.accounts[accountRef]
    : undefined;
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
