import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import type { QuotaAccount } from "@/provider-usage/global-quota";
import { factoryScopeKey, type FactoryScopeEntry } from "./all-factories-model";
import {
  FACTORY_CATEGORIES,
  type FactoryAgentInfo,
  type FactoryAgentLookup,
  type FactoryCategory,
} from "./overview-model";
import type { FactoryQueue } from "./queue";

/**
 * Deterministic sample data for the Factory overview. Everything here is labelled "Sample data"
 * wherever it renders; nothing in this file is ever presented as a reading.
 */

const REPO = "https://github.com/example/factory-sample";
const issue = (number: number) => `${REPO}/issues/${number}`;
const pull = (number: number) => `${REPO}/pull/${number}`;

type Issue = FactoryQueue["issues"][number];
const pr = (
  number: number,
  checks: "pending" | "passing" | "failing" | null,
  review: string | null,
) => ({
  number,
  url: pull(number),
  headSha: `sample${number}`,
  checks,
  reviewDecision: review,
});
const agent = (role: "lead" | "worker" | "reviewer", issueNumber: number, status: string) => ({
  role,
  agentId: `sample-${role}-${issueNumber}`,
  status,
});

const SAMPLE_ISSUES: Issue[] = [
  {
    number: 418,
    title: "Show account quota windows in the composer footer",
    url: issue(418),
    label: "ready",
    stage: "queued",
    pr: null,
    agents: [],
  },
  {
    number: 421,
    title: "Retry failed relay handshakes with backoff",
    url: issue(421),
    label: "ready",
    stage: "queued",
    pr: null,
    agents: [],
  },
  {
    number: 409,
    title: "Split the workspace sidebar into labelled groups",
    url: issue(409),
    label: "running",
    stage: "planning",
    pr: null,
    agents: [agent("lead", 409, "running")],
  },
  {
    number: 402,
    title: "Stream terminal output without dropping the first frame",
    url: issue(402),
    label: "running",
    stage: "building",
    pr: null,
    agents: [agent("lead", 402, "idle"), agent("worker", 402, "running")],
  },
  {
    number: 398,
    title: "Keyboard shortcut to reopen the last archived workspace",
    url: issue(398),
    label: "running",
    stage: "building",
    pr: pr(412, "pending", null),
    agents: [agent("lead", 398, "idle"), agent("worker", 398, "running")],
  },
  {
    number: 391,
    title: "Explain why a provider account is skipped by the picker",
    url: issue(391),
    label: "running",
    stage: "review",
    pr: pr(407, "passing", "REVIEW_REQUIRED"),
    agents: [agent("worker", 391, "idle"), agent("reviewer", 391, "running")],
  },
  {
    number: 387,
    title: "Fix stale diff stats after a force push",
    url: issue(387),
    label: "running",
    stage: "repair",
    pr: pr(405, "failing", "CHANGES_REQUESTED"),
    agents: [agent("worker", 387, "running"), agent("reviewer", 387, "idle")],
  },
  {
    number: 383,
    title: "Localize the installation approval toast",
    url: issue(383),
    label: "human-review",
    stage: "review",
    pr: pr(401, "passing", "APPROVED"),
    agents: [agent("worker", 383, "idle"), agent("reviewer", 383, "completed")],
  },
  {
    number: 377,
    title: "Cache provider model lists between reconnects",
    url: issue(377),
    label: "running",
    stage: "merging",
    pr: pr(399, "passing", "APPROVED"),
    agents: [agent("worker", 377, "completed"), agent("reviewer", 377, "completed")],
  },
  {
    number: 372,
    title: "Migrate legacy checklist storage to the shared model",
    url: issue(372),
    label: "blocked",
    stage: "blocked",
    pr: pr(394, "failing", null),
    agents: [agent("worker", 372, "error")],
    claim: { branch: "factory/issue-372", local: false, installation: "m2-studio/vorteo" },
  },
  {
    number: 365,
    title: "Decide the retention window for journal attachments",
    url: issue(365),
    label: "blocked",
    stage: "blocked",
    pr: null,
    agents: [],
  },
];

export function sampleFactoryQueue(now: number): FactoryQueue {
  return { fetchedAt: new Date(now - 90_000).toISOString(), error: null, issues: SAMPLE_ISSUES };
}

/** Tokens in thousands and dollars for each sample thread, plus how long ago it started. */
const SAMPLE_AGENT_USAGE: Record<
  string,
  [tokensK: number, usd: number, hoursAgo: number, provider: string]
> = {
  "sample-lead-409": [182, 1.42, 0.6, "claude"],
  "sample-lead-402": [240, 1.88, 5.2, "claude"],
  "sample-worker-402": [1310, 6.9, 4.8, "codex"],
  "sample-lead-398": [205, 1.6, 9.1, "claude"],
  "sample-worker-398": [2140, 11.2, 8.7, "claude"],
  "sample-worker-391": [1720, 8.4, 20.5, "codex"],
  "sample-reviewer-391": [410, 3.1, 2.2, "claude"],
  "sample-worker-387": [2960, 15.7, 31, "claude"],
  "sample-reviewer-387": [520, 3.9, 26, "codex"],
  "sample-worker-383": [1180, 6.1, 44, "codex"],
  "sample-reviewer-383": [360, 2.7, 12, "claude"],
  "sample-worker-377": [1490, 7.8, 52, "claude"],
  "sample-reviewer-377": [300, 2.3, 30, "codex"],
  "sample-worker-372": [880, 4.6, 70, "codex"],
};

export function sampleAgentLookup(now: number): FactoryAgentLookup {
  return (agentId) => {
    const entry = SAMPLE_AGENT_USAGE[agentId];
    if (!entry) return undefined;
    const [tokensK, usd, hoursAgo, provider] = entry;
    const info: FactoryAgentInfo = {
      provider,
      usage: {
        inputTokens: Math.round(tokensK * 860),
        outputTokens: Math.round(tokensK * 140),
        cachedInputTokens: Math.round(tokensK * 610),
        estimatedCostUsd: usd,
      },
      createdAt: new Date(now - hoursAgo * 3_600_000),
    };
    return info;
  };
}

/** Role threads have no ids in sample mode, so their share is added to the category totals. */
export const SAMPLE_ROLE_USAGE: Partial<Record<FactoryCategory, { tokens: number; usd: number }>> =
  {
    triage: { tokens: 640_000, usd: 3.4 },
    planning: { tokens: 910_000, usd: 5.9 },
    release: { tokens: 1_150_000, usd: 6.2 },
    mechanic: { tokens: 420_000, usd: 2.6 },
  };

// ---------------------------------------------------------------------------------------------
// History the daemon does not record yet.

export interface FactoryHistory {
  /** Issues merged per day, oldest first, 14 days ending today. */
  mergedPerDay: number[];
  /** Hours from claim to merge for recent merges, oldest first. */
  cycleHours: number[];
  /** Tokens per day per category, oldest first, 7 days ending today. */
  tokensByDay: Record<FactoryCategory, number>[];
  /** API-equivalent dollars per merged PR, oldest first. */
  costPerPr: { pr: number; usd: number }[];
  month: { spentUsd: number; capUsd: number; day: number; days: number };
  ticketCapUsd: number;
  /** Hours each queued issue has waited, by issue number. */
  queueAgeHours: Record<number, number>;
  /** How often the account picker chose each account this week. */
  accountPicks: { account: string; picks: number }[];
}

// A fixed seed keeps every render and screenshot identical.
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORY_BASE: Record<FactoryCategory, number> = {
  triage: 0.42,
  planning: 0.9,
  build: 3.6,
  review: 1.3,
  repair: 0.8,
  release: 0.7,
  mechanic: 0.3,
};

function buildHistory(): FactoryHistory {
  const random = seeded(20261107);
  const mergedPerDay = [2, 3, 1, 4, 3, 0, 1, 3, 5, 2, 4, 6, 3, 4];
  const cycleHours = Array.from({ length: 24 }, () => Math.round((3 + random() * 30) * 10) / 10);
  const tokensByDay = Array.from(
    { length: 7 },
    (_, day) =>
      Object.fromEntries(
        FACTORY_CATEGORIES.map((category) => [
          category,
          Math.round(
            CATEGORY_BASE[category] * (0.7 + random() * 0.6) * (day === 6 ? 0.55 : 1) * 1_000_000,
          ),
        ]),
      ) as Record<FactoryCategory, number>,
  );
  const costPerPr = Array.from({ length: 12 }, (_, index) => ({
    pr: 371 + index * 3,
    usd: Math.round((6 + random() * 22) * 100) / 100,
  }));
  return {
    mergedPerDay,
    cycleHours,
    tokensByDay,
    costPerPr,
    month: { spentUsd: 1182.4, capUsd: 1600, day: 7, days: 30 },
    ticketCapUsd: 40,
    queueAgeHours: { 418: 6.5, 421: 30 },
    accountPicks: [
      { account: "Claude · Max 1", picks: 23 },
      { account: "Claude · Max 2", picks: 17 },
      { account: "Codex · Pro", picks: 11 },
    ],
  };
}

export const SAMPLE_HISTORY: FactoryHistory = buildHistory();

// ---------------------------------------------------------------------------------------------
// Quota accounts, shown only in sample mode when the host reports none.

function sampleWindow(
  id: string,
  label: string,
  used: number,
  resetsInHours: number,
  now: number,
  random: () => number,
) {
  const history = Array.from({ length: 16 }, (_, index) => ({
    at: now - (15 - index) * 12 * 3_600_000,
    used: Math.min(100, Math.round(((used * (index + 1)) / 16) * (0.85 + random() * 0.3))),
  }));
  return {
    id,
    label,
    remaining: 100 - used,
    resetsAt: new Date(now + resetsInHours * 3_600_000).toISOString(),
    runsOutAt: null,
    separate: false,
    limiting: false,
    tone: null,
    history,
  };
}

export function sampleQuotaAccounts(now: number): QuotaAccount[] {
  const random = seeded(7);
  const account = (
    providerId: string,
    name: string,
    plan: string,
    running: number,
    windows: QuotaAccount["windows"],
  ): QuotaAccount => {
    const limiting = windows.reduce((low, window) =>
      (window.remaining ?? 100) < (low.remaining ?? 100) ? window : low,
    );
    return {
      providerId,
      name,
      plan,
      source: null,
      running,
      windows: windows.map((window) => ({ ...window, limiting: window === limiting })),
      balances: [],
      details: [],
      remaining: limiting.remaining,
      resetsAt: limiting.resetsAt,
      credits: null,
      observed: false,
      status: null,
      failing: false,
      disconnected: false,
      fetchedAt: new Date(now - 4 * 60_000).toISOString(),
      attention: (limiting.remaining ?? 100) < 15,
    };
  };
  return [
    account("claude-1", "Claude · Max 1", "Max 20x", 3, [
      sampleWindow("five_hour", "5h", 64, 2.4, now, random),
      sampleWindow("weekly", "Weekly", 41, 86, now, random),
    ]),
    account("claude-2", "Claude · Max 2", "Max 20x", 2, [
      sampleWindow("five_hour", "5h", 22, 4.1, now, random),
      sampleWindow("weekly", "Weekly", 88, 30, now, random),
    ]),
    account("codex-1", "Codex · Pro", "Pro", 2, [
      sampleWindow("five_hour", "5h", 35, 1.2, now, random),
      sampleWindow("weekly", "Weekly", 57, 120, now, random),
    ]),
  ];
}

/** API-equivalent dollars per sample account this month. */
export const SAMPLE_ACCOUNT_SPEND: Record<string, number> = {
  "claude-1": 512.3,
  "claude-2": 431.8,
  "codex-1": 238.3,
};

// ---------------------------------------------------------------------------------------------
// Several Factories, for the All Factories scope.

const SITE = "https://github.com/example/website-sample";
const SAMPLE_SITE_ISSUES: Issue[] = [
  {
    number: 58,
    title: "Add the pricing comparison table",
    url: `${SITE}/issues/58`,
    label: "running",
    stage: "building",
    pr: null,
    agents: [
      { role: "lead", agentId: "sample-site-lead-58", status: "idle" },
      { role: "worker", agentId: "sample-site-worker-58", status: "running" },
    ],
  },
  {
    number: 55,
    title: "Fix the dark mode logo on the docs header",
    url: `${SITE}/issues/55`,
    label: "running",
    stage: "review",
    pr: {
      number: 61,
      url: `${SITE}/pull/61`,
      headSha: "sample61",
      checks: "failing",
      reviewDecision: null,
    },
    agents: [{ role: "reviewer", agentId: "sample-site-reviewer-55", status: "idle" }],
  },
  {
    number: 52,
    title: "Compress hero images",
    url: `${SITE}/issues/52`,
    label: "running",
    stage: "merging",
    pr: {
      number: 60,
      url: `${SITE}/pull/60`,
      headSha: "sample60",
      checks: "passing",
      reviewDecision: "APPROVED",
    },
    agents: [{ role: "worker", agentId: "sample-site-worker-52", status: "completed" }],
  },
  {
    number: 63,
    title: "Write the changelog page",
    url: `${SITE}/issues/63`,
    label: "ready",
    stage: "queued",
    pr: null,
    agents: [],
  },
];
const DOCS = "https://github.com/example/handbook-sample";
const SAMPLE_DOCS_ISSUES: Issue[] = [
  {
    number: 14,
    title: "Explain the restart approval flow",
    url: `${DOCS}/issues/14`,
    label: "ready",
    stage: "queued",
    pr: null,
    agents: [],
  },
];

const SAMPLE_ROLES = [
  ["factory-triage", "Triage", "Labelled 2 new issues"],
  ["factory-intake", "Foreman", "Started #409; 3 workers running"],
  ["factory-builds", "Builds", "Merged #377 to main"],
  ["factory-releases", "Releases", "Beta 26.11.602 published"],
  ["factory-mechanic", "Mechanic", "Proposed new Builds instructions"],
] as const;

/** A sample Factory state. Only used while Sample factory is on, and never sent to a daemon. */
export function sampleFactoryState(
  serverId: string,
  projectId: string,
  options: { paused?: boolean; proposal?: boolean; now: number },
): ProjectFactoryState {
  const updatedAt = new Date(options.now - 20 * 60_000).toISOString();
  return {
    schemaVersion: 1,
    serverId,
    projectId,
    state: options.paused ? "paused" : "on",
    repository: null,
    reason: null,
    workers: { workerProfileId: null, reviewerProfileId: null, planning: true },
    drain: null,
    roles: SAMPLE_ROLES.map(([role, title, line]) => ({
      role,
      title,
      workspaceId: null,
      agentId: null,
      heartbeat: null,
      launch: { provider: null, profileId: null },
      status: { line, updatedAt },
      instructions: {
        revision: 1,
        review: options.proposal && role === "factory-builds" ? "proposed" : "none",
      },
    })),
  };
}

/** Three sample Factories: two running, one paused. */
export function sampleFactoryEntries(serverId: string, now: number): FactoryScopeEntry[] {
  const entry = (
    projectId: string,
    name: string,
    issues: Issue[],
    options: { paused?: boolean; proposal?: boolean },
  ): FactoryScopeEntry => {
    const state = sampleFactoryState(serverId, projectId, { ...options, now });
    return {
      key: factoryScopeKey(serverId, projectId),
      serverId,
      projectId,
      name,
      hostLabel: null,
      state,
      status: state.state,
      drain: null,
      issues,
    };
  };
  return [
    entry("sample-vorteo", "Vorteo", SAMPLE_ISSUES, { proposal: true }),
    entry("sample-website", "Website", SAMPLE_SITE_ISSUES, {}),
    entry("sample-handbook", "Handbook", SAMPLE_DOCS_ISSUES, { paused: true }),
  ];
}
