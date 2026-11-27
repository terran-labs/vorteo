import type { MutableDaemonConfig, ProviderUsage } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  pickWorkerAccount,
  type WorkerAccountCandidate,
  type WorkerAccountInput,
  type WorkerAccountPick,
} from "./worker-account.js";

const now = "2026-11-27T18:00:00.000Z";
const soon = "2026-11-27T19:00:00.000Z";
const later = "2026-11-27T20:00:00.000Z";
const nextDay = "2026-11-28T18:00:00.000Z";

function reading(
  providerId: string,
  windows: Array<[remainingPct: number | null, resetsAt?: string]>,
): ProviderUsage {
  return {
    providerId,
    displayName: providerId,
    planLabel: null,
    status: "available",
    windows: windows.map(([remainingPct, resetsAt], index) => ({
      id: String(index),
      label: String(index),
      remainingPct,
      resetsAt,
    })),
  };
}

interface Case {
  title: string;
  readings: ProviderUsage[];
  settings?: MutableDaemonConfig;
  avoidProvider?: string;
  options?: Partial<WorkerAccountInput>;
  evidence?: Partial<WorkerAccountCandidate>[];
  result: Omit<WorkerAccountPick, "candidates"> & { droppedLowProviders?: string[] };
}

const cases: Case[] = [
  {
    title: "parks a positively measured account while an installation alias is held",
    readings: [reading("codex", [[95]]), reading("backup", [[55]])],
    settings: {
      providers: { backup: { extends: "codex", env: { CODEX_HOME: "/tmp/worker-hold-backup" } } },
    },
    options: {
      installationDefinitionByProvider: { codex: "held-definition", alias: "held-definition" },
      usageLimitedUntilByProvider: { alias: soon },
    },
    result: { provider: "backup", reason: "known-headroom", earliestResetAt: null },
    evidence: [
      { provider: "backup", eligibility: "eligible" },
      {
        provider: "codex",
        eligibility: "known-low",
        exclusionReason: "usage-limit-hold",
        remainingPct: 95,
        earliestResetAt: soon,
      },
      { provider: "alias", eligibility: "ineligible", exclusionReason: "not-ready" },
    ],
  },
  {
    title: "allows a measured account after its hold expires",
    readings: [reading("codex", [[95]])],
    options: { usageLimitedUntilByProvider: { codex: now } },
    result: { provider: "codex", reason: "known-headroom", earliestResetAt: null },
  },
  {
    title: "keeps disabled and unreported destination bindings in the evidence",
    readings: [],
    options: {
      ready: [{ provider: "codex", enabled: false, status: "ready" }],
      installationDefinitionByProvider: {
        codex: "default-definition",
        missing: "missing-definition",
      },
    },
    result: { provider: null, reason: "no-eligible-account", earliestResetAt: null },
    evidence: [
      { provider: "codex", eligibility: "ineligible", exclusionReason: "disabled" },
      {
        provider: "missing",
        eligibility: "ineligible",
        exclusionReason: "not-ready",
        installationDefinitionId: "missing-definition",
      },
    ],
  },
  {
    title: "picks the strongest worst window",
    readings: [reading("codex", [[95], [30]]), reading("backup", [[60], [55]])],
    result: { provider: "backup", reason: "known-headroom", earliestResetAt: null },
    evidence: [
      {
        provider: "backup",
        installationDefinitionId: null,
        eligibility: "eligible",
        capacity: null,
        floorPct: 25,
        reservedHeadroomPct: 0,
        remainingPct: 55,
        readingAgeMs: 0,
        windows: [
          { id: "0", remainingPct: 60, resetsAt: null },
          { id: "1", remainingPct: 55, resetsAt: null },
        ],
      },
      { provider: "codex", remainingPct: 30 },
    ],
  },
  {
    title: "parks a measured-only request when usage is unreadable",
    readings: [],
    options: { requireMeasured: true },
    result: { provider: null, reason: "measurement-required", earliestResetAt: null },
    evidence: [
      { provider: "codex", eligibility: "unreadable", exclusionReason: "measurement-required" },
      { provider: "backup", eligibility: "unreadable", exclusionReason: "measurement-required" },
    ],
  },
  {
    title: "requires headroom strictly above the floor and reservation",
    readings: [reading("codex", [[35, soon]]), reading("backup", [[36]])],
    options: { requireMeasured: true, reservedHeadroomPct: 10 },
    result: { provider: "backup", reason: "known-headroom", earliestResetAt: null },
    evidence: [
      { provider: "backup", eligibility: "eligible", reservedHeadroomPct: 10 },
      {
        provider: "codex",
        eligibility: "known-low",
        floorPct: 25,
        reservedHeadroomPct: 10,
        earliestResetAt: soon,
      },
    ],
  },
  {
    title: "parks when the cap is reached and fails closed on an invalid count",
    readings: [reading("codex", [[95]]), reading("backup", [[99]])],
    options: {
      capacityByProvider: { codex: { cap: 1, current: 1 }, backup: { cap: 2, current: -1 } },
    },
    result: { provider: null, reason: "no-capacity", earliestResetAt: null },
    evidence: [
      {
        provider: "codex",
        eligibility: "ineligible",
        exclusionReason: "capacity-reached",
        capacity: { cap: 1, current: 1 },
      },
      {
        provider: "backup",
        eligibility: "ineligible",
        exclusionReason: "invalid-capacity",
        capacity: null,
      },
    ],
  },
  {
    title: "fails closed on a nonfinite reservation",
    readings: [reading("codex", [[95]])],
    options: { reservedHeadroomPct: NaN },
    result: { provider: null, reason: "invalid-reservation", earliestResetAt: null },
    evidence: [
      { provider: "codex", exclusionReason: "invalid-reservation", reservedHeadroomPct: null },
      { provider: "backup", exclusionReason: "invalid-reservation", reservedHeadroomPct: null },
    ],
  },
  {
    title: "prefers a different measured reviewer account over the builder and its aliases",
    readings: [reading("codex", [[95]]), reading("alias", [[98]]), reading("backup", [[60]])],
    settings: {
      providers: {
        alias: { extends: "codex" },
        backup: { extends: "codex", env: { CODEX_HOME: "/tmp/distinct-reviewer-account" } },
      },
    },
    options: {
      deprioritizeProviders: ["codex"],
      installationDefinitionByProvider: {
        codex: "builder-definition",
        alias: "builder-definition",
      },
    },
    result: { provider: "backup", reason: "known-headroom", earliestResetAt: null },
    evidence: [
      { provider: "backup", installationDefinitionId: null },
      { provider: "alias", installationDefinitionId: "builder-definition", accountRef: "alias" },
      { provider: "codex", installationDefinitionId: "builder-definition" },
    ],
  },
  {
    title: "keeps the builder eligible when it is the only measured account",
    readings: [reading("codex", [[60]])],
    options: { deprioritizeProviders: ["codex"] },
    result: { provider: "codex", reason: "known-headroom", earliestResetAt: null },
  },
  {
    title: "uses the preset default on an equal score above the floor",
    readings: [reading("codex", [[26]]), reading("backup", [[26]])],
    result: { provider: "codex", reason: "known-headroom", earliestResetAt: null },
  },
  {
    title: "treats exactly the floor as blocked",
    readings: [reading("codex", [[25, soon]]), reading("backup", [[0, later]])],
    result: { provider: null, reason: "quota-below-floor", earliestResetAt: soon },
  },
  {
    title: "uses the eligible preset default when all usage is unreadable",
    readings: [],
    result: { provider: "codex", reason: "default-usage-unreadable", earliestResetAt: null },
  },
  {
    title: "falls back to the first unreadable eligible account when the default is signed out",
    readings: [{ ...reading("codex", []), credentialsMissing: true }],
    result: { provider: "backup", reason: "alternate-usage-unreadable", earliestResetAt: null },
  },
  {
    title: "leaves opted-out accounts and aliases of the stopped account out",
    readings: [reading("backup", [[99]]), reading("alias", [[100]])],
    settings: {
      providers: {
        codex: { env: { CODEX_HOME: "/tmp/paseo-quota-test-home" } },
        backup: { extends: "codex", automaticPrimary: false },
        alias: { extends: "codex" },
      },
    },
    avoidProvider: "codex",
    result: { provider: null, reason: "no-eligible-account", earliestResetAt: null },
  },
  {
    title: "reports the earliest account reset across all of each account's blocking windows",
    readings: [
      reading("codex", [
        [0, soon],
        [19, nextDay],
      ]),
      reading("backup", [[0, later]]),
    ],
    result: { provider: null, reason: "quota-below-floor", earliestResetAt: later },
  },
  {
    title: "drops a partially unreadable account with a known low window",
    readings: [reading("backup", [[null], [15, soon]])],
    result: {
      provider: "codex",
      reason: "default-usage-unreadable",
      earliestResetAt: null,
      droppedLowProviders: ["backup"],
    },
  },
  {
    title: "drops an exhausted default and picks the first unreadable alternate",
    readings: [reading("codex", [[0, soon]])],
    settings: { providers: { alias: { extends: "codex" } } },
    result: {
      provider: "backup",
      reason: "alternate-usage-unreadable",
      earliestResetAt: null,
      droppedLowProviders: ["codex"],
    },
  },
  {
    title: "fails closed on an unsupported quota policy",
    readings: [reading("codex", [[95]])],
    settings: { accountQuotaPolicy: { version: 2 } },
    result: { provider: null, reason: "quota-policy-unresolved", earliestResetAt: null },
  },
  {
    title: "excludes accounts outside the pool and honors an account floor override",
    readings: [reading("codex", [[55, soon]]), reading("backup", [[0, later]])],
    settings: {
      accountQuotaPolicy: {
        version: 1,
        ladder: {},
        accounts: { codex: { floors: { normal: 60 } }, backup: { pool: false } },
      },
    },
    result: { provider: null, reason: "quota-below-floor", earliestResetAt: soon },
  },
];

describe("quota-picked worker account", () => {
  it.each(cases)(
    "$title",
    async ({ readings, settings, avoidProvider, options, evidence, result }) => {
      const providers = {
        backup: { extends: "codex" },
        ...settings?.providers,
      };
      const ready = [...new Set([...Object.keys(providers), "codex"])].map((provider) => ({
        provider,
        enabled: true,
        status: "ready" as const,
      }));
      const { candidates, ...choice } = await pickWorkerAccount({
        settings: { ...settings, providers },
        ready,
        usage: { fetchedAt: now, providers: readings },
        providerType: "codex",
        defaultProvider: "codex",
        priority: "normal",
        nowMs: Date.parse(now),
        avoidProvider,
        ...options,
      });
      expect(choice).toEqual(result);
      const supplied = (options?.ready ?? ready).map(({ provider }) => provider);
      const bindings = Object.keys(options?.installationDefinitionByProvider ?? {});
      expect(candidates).toHaveLength(new Set([...supplied, ...bindings]).size);
      if (evidence) expect(candidates).toMatchObject(evidence);
    },
  );
});
