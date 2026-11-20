import type { ProviderUsage } from "@getpaseo/protocol/messages";
import type { AccountQuotaPolicyWire } from "@getpaseo/protocol/account-quota-policy";
import { describe, expect, it } from "vitest";

import { evaluateFloor, type FloorInput } from "./floor.js";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const REF = "installation-account/11111111-1111-4111-8111-111111111111";
const UPPER_HEX_REF = "installation-account/ABCDEF12-3456-4789-ABCD-EF1234567890";

function reading(windows: Record<string, number | null>, extra: Partial<ProviderUsage> = {}) {
  return {
    providerId: "claude-a",
    displayName: "Claude A",
    status: "available",
    planLabel: null,
    windows: Object.entries(windows).map(([id, remainingPct]) => ({ id, label: id, remainingPct })),
    ...extra,
  } satisfies ProviderUsage;
}

function input(over: Partial<FloorInput> & { providers?: ProviderUsage[]; fetchedAt?: string }) {
  const { providers, fetchedAt, ...rest } = over;
  return {
    accountRef: REF,
    providerId: "claude-a",
    priority: "normal",
    nowMs: NOW,
    usage: {
      fetchedAt: fetchedAt ?? new Date(NOW - 60_000).toISOString(),
      providers: providers ?? [reading({ "5h": 40, weekly: 80 })],
    },
    ...rest,
  } satisfies FloorInput;
}

const policy = (value: Record<string, unknown>): AccountQuotaPolicyWire => ({
  version: 1,
  ladder: {},
  accounts: {},
  ...value,
});

describe("evaluateFloor", () => {
  it.each<[string, FloorInput, Record<string, unknown>]>([
    [
      "above floor on the lowest window, built-in ladder without a policy",
      input({}),
      {
        kind: "above-floor",
        floorPct: 25,
        floorSource: "built-in",
        bindingWindowId: "5h",
        remainingPct: 40,
        pool: null,
      },
    ],
    [
      "below floor names the binding window and percentages",
      input({ priority: "low" }),
      {
        kind: "below-floor",
        floorPct: 50,
        bindingWindowId: "5h",
        remainingPct: 40,
        ownerPlacementExempt: false,
      },
    ],
    [
      "owner placement is reported as exempt only when below",
      input({ priority: "low", ownerPlaced: true }),
      { kind: "below-floor", ownerPlacementExempt: true },
    ],
    [
      "account override beats the ladder",
      input({
        policy: policy({
          ladder: { normal: 10 },
          accounts: { [REF]: { pool: true, floors: { normal: 45 } } },
        }),
      }),
      { kind: "below-floor", floorPct: 45, floorSource: "account", pool: true },
    ],
    [
      "ladder beats built-in",
      input({ priority: "low", policy: policy({ ladder: { low: 30 } }) }),
      { kind: "above-floor", floorPct: 30, floorSource: "ladder", pool: null },
    ],
    [
      "no reading (setup-token sign-in) is unmeasured",
      input({ providers: [] }),
      { kind: "unmeasured", reason: "no-reading", floorPct: 25 },
    ],
    [
      "reading without a usable percentage is unmeasured",
      input({ providers: [reading({ "5h": null })] }),
      { kind: "unmeasured", reason: "unreadable" },
    ],
    [
      "a reading older than the account-choice freshness rule is unmeasured",
      input({ fetchedAt: new Date(NOW - 6 * 60_000).toISOString() }),
      { kind: "unmeasured", reason: "stale" },
    ],
    [
      "an exhausted window is limited",
      input({ priority: "urgent", providers: [reading({ "5h": 0, weekly: 50 })] }),
      { kind: "limited", bindingWindowId: "5h" },
    ],
    [
      "a recorded limit hold is limited whatever the reading says",
      input({ limitHold: true }),
      { kind: "limited", bindingWindowId: "5h" },
    ],
    [
      "unknown priority is unresolved",
      input({ priority: "critical", policy: policy({ ladder: { someday: 5 } }) }),
      { kind: "unresolved", reason: "unknown-priority" },
    ],
    [
      "an override keyed by an uppercase-hex installation account applies",
      input({
        accountRef: UPPER_HEX_REF,
        policy: policy({
          accounts: { [UPPER_HEX_REF]: { floors: { normal: 45 } } },
        }),
      }),
      { kind: "below-floor", floorPct: 45, floorSource: "account" },
    ],
    [
      "a malformed floor makes the policy unusable, never a lower level's floor",
      input({
        policy: policy({ ladder: { normal: 140 }, accounts: { [REF]: { floors: { high: -1 } } } }),
      }),
      { kind: "unresolved", reason: "invalid-policy", version: 1 },
    ],
    [
      "a non-number floor read from a file is unresolved",
      input({ policy: policy({ ladder: { normal: "25" } }) }),
      { kind: "unresolved", reason: "invalid-policy", version: 1 },
    ],
    [
      "a policy of another version is unusable and names the version",
      input({ policy: { version: 2, ladder: { normal: 0 } } }),
      { kind: "unresolved", reason: "unsupported-version", version: 2 },
    ],
    ...(
      [
        ["a ladder that is a string", { ladder: "garbage" }],
        ["a ladder that is an array", { ladder: [90] }],
        ["accounts that are a string", { accounts: "x" }],
        ["an account row that is a number", { accounts: { [REF]: 90 } }],
        ["account floors that are a string", { accounts: { [REF]: { floors: "90" } } }],
        ["an unknown field", { note: "added by a newer client" }],
      ] as const
    ).map(([what, malformed]): [string, FloorInput, Record<string, unknown>] => [
      `${what} makes the policy unusable, not above floor`,
      input({ policy: policy(malformed), providers: [reading({ "5h": 45 })] }),
      { kind: "unresolved", reason: "invalid-policy", version: 1 },
    ]),
    [
      "a limit hold is limited even under an unusable policy",
      input({ limitHold: true, policy: { version: 2 } }),
      { kind: "limited", bindingWindowId: "5h" },
    ],
    [
      "a reading dated after now is unmeasured",
      input({ fetchedAt: new Date(NOW + 365 * 24 * 3_600_000).toISOString() }),
      { kind: "unmeasured", reason: "future-dated" },
    ],
    [
      "a remaining percentage over 100 is unmeasured",
      input({ providers: [reading({ "5h": 140, weekly: 80 })] }),
      { kind: "unmeasured", reason: "out-of-range" },
    ],
  ])("%s", (_name, given, expected) => {
    expect(evaluateFloor(given)).toMatchObject(expected);
  });
});
