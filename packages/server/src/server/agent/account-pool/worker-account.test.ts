import type { MutableDaemonConfig, ProviderUsage } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  pickWorkerAccount,
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
  usageLimitedUntilByProvider?: WorkerAccountInput["usageLimitedUntilByProvider"];
  result: WorkerAccountPick;
}

const cases: Case[] = [
  {
    title: "excludes a positively measured account when an alias has an active usage hold",
    readings: [reading("codex", [[95]]), reading("backup", [[55]])],
    settings: {
      providers: {
        codex: { env: { CODEX_HOME: "/tmp/worker-hold-account" } },
        alias: { extends: "codex" },
        backup: { extends: "codex", env: { CODEX_HOME: "/tmp/worker-hold-backup" } },
      },
    },
    usageLimitedUntilByProvider: { alias: soon },
    result: { provider: "backup", reason: "known-headroom", earliestResetAt: null },
  },
  {
    title: "reports the earliest account release when holds and quota windows both block placement",
    readings: [reading("codex", [[90], [10, nextDay]]), reading("backup", [[90]])],
    settings: {
      providers: { backup: { extends: "codex", env: { CODEX_HOME: "/tmp/worker-hold-backup" } } },
    },
    usageLimitedUntilByProvider: { codex: soon, backup: later },
    result: { provider: null, reason: "quota-below-floor", earliestResetAt: later },
  },
  {
    title: "allows placement after a usage hold expires",
    readings: [reading("codex", [[95]])],
    usageLimitedUntilByProvider: { codex: now },
    result: { provider: "codex", reason: "known-headroom", earliestResetAt: null },
  },
  {
    title: "picks the strongest worst window",
    readings: [reading("codex", [[95], [30]]), reading("backup", [[60], [55]])],
    result: { provider: "backup", reason: "known-headroom", earliestResetAt: null },
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
    async ({ readings, settings, avoidProvider, usageLimitedUntilByProvider, result }) => {
      const providers = {
        backup: { extends: "codex" },
        ...settings?.providers,
      };
      const ready = [...Object.keys(providers), "codex"].map((provider) => ({
        provider,
        enabled: true,
        status: "ready" as const,
      }));
      expect(
        await pickWorkerAccount({
          settings: { ...settings, providers },
          ready,
          usage: { fetchedAt: now, providers: readings },
          providerType: "codex",
          defaultProvider: "codex",
          priority: "normal",
          nowMs: Date.parse(now),
          avoidProvider,
          usageLimitedUntilByProvider,
        }),
      ).toEqual(result);
    },
  );
});
