import {
  BUILT_IN_QUOTA_FLOORS,
  isQuotaFloor,
  type QuotaPolicy,
} from "@getpaseo/protocol/quota-policy";

import { rankAccounts, type UsageList } from "../../factory/project/account-choice.js";

/**
 * Pure quota floor evaluation (#518 slice 6). Nothing calls this yet: admission, launch, switch
 * and pause paths behave as before. A floor is the percent of every usage window an account must
 * keep for a given priority; the binding window is whichever has the least remaining now.
 *
 * Freshness and window validity come from Factory account choice (`rankAccounts`), so both
 * agree on what counts as a usable reading. A stale reading is unmeasured; no grace period.
 */

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
      reason: "no-reading" | "unreadable" | "stale";
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
    };

export interface FloorInput {
  /** `installationProviderReference` of the account; keys `policy.accounts`. */
  accountRef: string;
  /** The local provider id whose reading is in `usage`. */
  providerId: string;
  priority: string;
  /** Absent policy: built-in ladder, pool membership unstated. */
  policy?: QuotaPolicy | null;
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
  policy: QuotaPolicy | null | undefined,
  accountRef: string,
  priority: string,
): { floorPct: number; source: FloorSource } | { invalid: true } | null {
  const levels: [FloorSource, Record<string, unknown> | undefined][] = [
    ["account", policy?.accounts?.[accountRef]?.floors],
    ["ladder", policy?.ladder],
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
  const pool = poolMembership(input.policy, input.accountRef);
  const reading = input.usage.providers.find((item) => item.providerId === input.providerId);
  const lowest = lowestWindow(reading?.windows ?? []);

  if (input.limitHold) return { kind: "limited", bindingWindowId: lowest?.id ?? null, pool };

  const floor = resolveFloor(input.policy, input.accountRef, input.priority);
  if (floor === null) return { kind: "unresolved", reason: "unknown-priority", pool };
  if ("invalid" in floor) return { kind: "unresolved", reason: "invalid-floor", pool };
  const { floorPct, source: floorSource } = floor;

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
function poolMembership(policy: QuotaPolicy | null | undefined, accountRef: string) {
  const value = policy?.accounts?.[accountRef]?.pool;
  return typeof value === "boolean" ? value : null;
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
