import { describe, expect, it } from "vitest";
import { bestChoice, rankedRows, rankAccounts } from "./best-account";
import { quotaAccounts, type QuotaAccount } from "./global-quota";
import { LIMIT_OBSERVATION_DETAIL_ID } from "./quota-reading";
import {
  accountRunway,
  dayTicks,
  formatShortMoment,
  RUNWAY_HORIZON_MS,
  runwayDescription,
  runwayLabel,
  runwaySummary,
} from "./runway";
import type { ProviderUsage, ProviderUsageView } from "./types";

// Mon Nov 2 2026, 1:45 PM in Los Angeles.
const now = Date.parse("2026-11-02T21:45:00.000Z");
const zone = "America/Los_Angeles";
const fetchedAt = new Date(now - 40_000).toISOString();
const sunday8am = "2026-11-08T16:00:00.000Z";
const tuesday1040pm = "2026-11-04T06:40:00.000Z";
const tuesday1036pm = "2026-11-04T06:36:00.000Z";
const tuesday145pm = "2026-11-03T21:45:00.000Z";
const tonight11pm = "2026-11-03T07:00:00.000Z";

function usage(providerId: string, overrides: Partial<ProviderUsage>): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    status: "available",
    planLabel: null,
    fetchedAt,
    windows: [],
    ...overrides,
  };
}

const installation: ProviderUsage[] = [
  usage("claude-2", {
    displayName: "Claude 2",
    planLabel: "Max 20x",
    windows: [
      { id: "five_hour", label: "Session", remainingPct: 100, resetsAt: null },
      { id: "seven_day", label: "Weekly", remainingPct: 100, resetsAt: sunday8am },
      { id: "seven_day_fable", label: "Weekly · Fable", remainingPct: 100, resetsAt: sunday8am },
    ],
  }),
  usage("codex-1", {
    displayName: "Codex 1",
    planLabel: "Pro",
    windows: [{ id: "weekly", label: "Weekly", remainingPct: 23, resetsAt: tuesday1040pm }],
  }),
  usage("codex-2", {
    displayName: "Codex 2",
    windows: [{ id: "weekly", label: "Weekly", remainingPct: 0, resetsAt: tuesday145pm }],
    balances: [{ id: "credits", label: "Credits", remaining: 4639.78, unit: "credits" }],
  }),
  usage("codex-3", {
    displayName: "Codex 3",
    planLabel: "Pro",
    windows: [{ id: "weekly", label: "Weekly", remainingPct: 0, resetsAt: tuesday1036pm }],
    balances: [{ id: "credits", label: "Credits", remaining: 21021.991, unit: "credits" }],
  }),
  usage("claude-1", {
    displayName: "Claude 1",
    windows: [{ id: "weekly", label: "Weekly", remainingPct: 0, resetsAt: tonight11pm }],
    details: [
      { id: "claude-setup-token", label: "Sign-in", value: "Setup token" },
      { id: LIMIT_OBSERVATION_DETAIL_ID, label: "Source", value: "From last limit message" },
    ],
  }),
];

function view(providers: ProviderUsage[]): ProviderUsageView {
  return {
    kind: "ready",
    isRefreshing: false,
    payload: { requestId: "test", fetchedAt, providers },
  };
}

function accountsOf(providers: ProviderUsage[]): Record<string, QuotaAccount> {
  return Object.fromEntries(
    quotaAccounts(view(providers), now).map((account) => [account.providerId, account]),
  );
}

const accounts = accountsOf(installation);
const fraction = (iso: string) => (Date.parse(iso) - now) / RUNWAY_HORIZON_MS;

describe("accountRunway", () => {
  it("keeps a full account on plan capacity with a notch at its weekly reset", () => {
    const runway = accountRunway(accounts["claude-2"]!, now);
    expect(runway.segments).toEqual([{ state: "capacity", start: 0, end: 1 }]);
    expect(runway.resets).toEqual([fraction(sunday8am)]);
    // Tied full windows name the earliest known reset, not the unstarted session.
    expect(accounts["claude-2"]!.resetsAt).toBe(sunday8am);
    expect(runwaySummary(accounts["claude-2"]!, runway, now, zone)).toBe(
      "100% left · resets Sun 8:00 AM",
    );
    expect(runwayLabel(accounts["claude-2"]!, runway)).toBeNull();
  });

  it("runs low at 23%, the tone.ts warning range, until the reset", () => {
    const runway = accountRunway(accounts["codex-1"]!, now);
    expect(runway.segments).toEqual([
      { state: "low", start: 0, end: fraction(tuesday1040pm) },
      { state: "capacity", start: fraction(tuesday1040pm), end: 1 },
    ]);
    expect(runwaySummary(accounts["codex-1"]!, runway, now, zone)).toBe(
      "23% left · resets Tue 10:40 PM",
    );
  });

  it("draws from prepaid credits while the plan is spent", () => {
    const runway = accountRunway(accounts["codex-2"]!, now);
    expect(runway.segments.map((segment) => segment.state)).toEqual(["credits", "capacity"]);
    expect(runway).toMatchObject({ state: "credits", returnsAt: tuesday145pm });
    expect(accounts["codex-2"]!.credits).toBe(4639.78);
    expect(runwaySummary(accounts["codex-2"]!, runway, now, zone)).toBe(
      "4,639.78 credits · plan back Tue 1:45 PM",
    );
    expect(runwayLabel(accounts["codex-2"]!, runway)).toEqual({
      text: "On credits",
      tone: "muted",
    });
    expect(runwayDescription(runway, now, RUNWAY_HORIZON_MS, zone)).toBe(
      "prepaid credits until Tue 1:45 PM, then plan capacity",
    );
  });

  it("is out until an observed limit lifts, then unknown without live usage", () => {
    expect(accounts["claude-1"]!.observed).toBe(true);
    const runway = accountRunway(accounts["claude-1"]!, now);
    expect(runway.segments).toEqual([
      { state: "out", start: 0, end: fraction(tonight11pm) },
      { state: "unknown", start: fraction(tonight11pm), end: 1 },
    ]);
    expect(runwaySummary(accounts["claude-1"]!, runway, now, zone)).toBe("Out until 11:00 PM");
    expect(runwayLabel(accounts["claude-1"]!, runway)).toEqual({ text: "Out", tone: "danger" });
  });

  it("returns to capacity at a reset that falls between whole minutes", () => {
    const resetsAt = new Date(now + 24 * 3_600_000 + 29_500).toISOString();
    const nearby = new Date(now + 24 * 3_600_000 + 5_000).toISOString();
    const { codex: account } = accountsOf([
      usage("codex", {
        windows: [
          { id: "weekly", label: "Weekly", remainingPct: 0, resetsAt },
          { id: "session", label: "5-hour", remainingPct: 50, resetsAt: nearby },
        ],
      }),
    ]);
    const runway = accountRunway(account!, now);
    expect(runway.segments).toEqual([
      { state: "out", start: 0, end: fraction(resetsAt) },
      { state: "capacity", start: fraction(resetsAt), end: 1 },
    ]);
    expect(runway.resets).toEqual([fraction(resetsAt)]);
  });

  it("stays out across the week when nothing says when the limit lifts", () => {
    const { "out-1": account } = accountsOf([
      usage("out-1", { windows: [{ id: "weekly", label: "Weekly", remainingPct: 0 }] }),
    ]);
    const runway = accountRunway(account!, now);
    expect(runway.segments).toEqual([{ state: "out", start: 0, end: 1 }]);
    expect(runwaySummary(account!, runway, now, zone)).toBe("Out of quota");
  });

  it("shows a setup-token account without usage as unknown", () => {
    const { "claude-3": account } = accountsOf([
      usage("claude-3", {
        details: [{ id: "claude-setup-token", label: "Sign-in", value: "Setup token" }],
      }),
    ]);
    const runway = accountRunway(account!, now);
    expect(runway.segments).toEqual([{ state: "unknown", start: 0, end: 1 }]);
    expect(runwaySummary(account!, runway, now, zone)).toBe("Usage not provided");
  });

  it("runs low until the binding window resets and lets the separate code review allowance pass", () => {
    const sessionReset = new Date(now + 3 * 3_600_000).toISOString();
    const { codex: account } = accountsOf([
      usage("codex", {
        windows: [
          { id: "session", label: "5-hour", remainingPct: 10, resetsAt: sessionReset },
          { id: "weekly", label: "Weekly", remainingPct: 40, resetsAt: tuesday1040pm },
          { id: "code_review", label: "Code review", remainingPct: 0, resetsAt: sunday8am },
        ],
      }),
    ]);
    const runway = accountRunway(account!, now);
    expect(runway.segments).toEqual([
      { state: "low", start: 0, end: fraction(sessionReset) },
      { state: "capacity", start: fraction(sessionReset), end: 1 },
    ]);
    expect(runway.resets).toEqual([fraction(sessionReset), fraction(tuesday1040pm)]);
    expect(account).toMatchObject({ remaining: 10, resetsAt: sessionReset });
  });

  it("leaves a disconnected account's lane unknown", () => {
    const { codex: account } = accountsOf([
      usage("codex", {
        authRecovery: { instructions: "Sign in again." },
        windows: [{ id: "weekly", label: "Weekly", remainingPct: 60, resetsAt: tuesday1040pm }],
      }),
    ]);
    const runway = accountRunway(account!, now);
    expect(runway.segments).toEqual([{ state: "unknown", start: 0, end: 1 }]);
    expect(runwaySummary(account!, runway, now)).toBe("Account disconnected");
  });
});

describe("Best now", () => {
  it("ranks plan capacity, then credits returning soonest, then out", () => {
    const rows = rankedRows(Object.values(accounts), now);
    expect(rows.map((row) => row.account.providerId)).toEqual([
      "claude-2",
      "codex-1",
      "codex-2",
      "codex-3",
      "claude-1",
    ]);
    const choice = bestChoice(rows, now, zone);
    expect(choice).toMatchObject({
      waiting: false,
      best: { reason: "Full on every window · resets Sun 8:00 AM" },
      next: { reason: "23% left · resets Tue 10:40 PM" },
    });
    expect(choice?.best.account.providerId).toBe("claude-2");
    expect(choice?.next?.account.providerId).toBe("codex-1");
  });

  it("prefers the earlier reset between equal accounts, because that capacity expires first", () => {
    const { early, late } = accountsOf([
      usage("late", {
        windows: [{ id: "weekly", label: "Weekly", remainingPct: 80, resetsAt: sunday8am }],
      }),
      usage("early", {
        windows: [{ id: "weekly", label: "Weekly", remainingPct: 80, resetsAt: tuesday1040pm }],
      }),
    ]);
    const ranked = rankAccounts(
      [late!, early!].map((account) => ({ account, runway: accountRunway(account, now) })),
    );
    expect(ranked.map((entry) => entry.account.providerId)).toEqual(["early", "late"]);
  });

  it("leaves out accounts needing sign-in and lists them first among rows", () => {
    const signedOut = accountsOf([
      usage("codex-9", {
        authRecovery: { instructions: "Sign in again." },
        windows: [{ id: "weekly", label: "Weekly", remainingPct: 100, resetsAt: sunday8am }],
      }),
    ])["codex-9"]!;
    const rows = rankedRows([accounts["codex-1"]!, signedOut, accounts["claude-1"]!], now);
    expect(rows.map((row) => row.account.providerId)).toEqual(["codex-9", "codex-1", "claude-1"]);
    const choice = bestChoice(rows, now, zone);
    expect(choice?.best.account.providerId).toBe("codex-1");
    // An account that is out is never offered as the runner-up.
    expect(choice?.next).toBeNull();
  });

  it("names the account back first when everything is out", () => {
    const later = accountsOf([
      usage("claude-4", {
        windows: [{ id: "seven_day", label: "Weekly", remainingPct: 0, resetsAt: sunday8am }],
      }),
    ])["claude-4"]!;
    const choice = bestChoice(rankedRows([later, accounts["claude-1"]!], now), now, zone);
    expect(choice).toMatchObject({ waiting: true, best: { reason: "Out until 11:00 PM" } });
  });

  it("offers no choice for a single account", () => {
    expect(bestChoice(rankedRows([accounts["codex-1"]!], now), now)).toBeNull();
  });
});

describe("time labels", () => {
  it("drops the weekday for a moment later today", () => {
    expect(formatShortMoment(tonight11pm, now, zone)).toBe("11:00 PM");
    expect(formatShortMoment(tuesday1040pm, now, zone)).toBe("Tue 10:40 PM");
    expect(formatShortMoment(null, now, zone)).toBeNull();
  });

  it("ticks at each local midnight inside the week", () => {
    const ticks = dayTicks(now);
    expect(ticks.length).toBeGreaterThanOrEqual(6);
    expect(ticks.length).toBeLessThanOrEqual(7);
    for (const tick of ticks) {
      const at = new Date(now + tick.at * RUNWAY_HORIZON_MS);
      expect([at.getHours(), at.getMinutes()]).toEqual([0, 0]);
      expect(tick.at).toBeGreaterThan(0);
      expect(tick.at).toBeLessThan(1);
      // Labels sit mid-day, about half a day after the midnight.
      expect((tick.center - tick.at) * 14).toBeCloseTo(1, 1);
    }
  });
});
