import type { AgentUsage } from "@getpaseo/protocol/agent-types";
import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import type { FactoryQueue } from "./queue";

/** Which Factory an issue belongs to, set when the overview shows several Factories. */
export interface FactoryIssueOrigin {
  key: string;
  serverId: string;
  projectId: string;
  label: string;
}

export type FactoryIssue = FactoryQueue["issues"][number] & { origin?: FactoryIssueOrigin };
export type FactoryStage = FactoryIssue["stage"];

/** Issue numbers repeat across repositories, so scoped views key issues by Factory too. */
export function factoryIssueKey(issue: Pick<FactoryIssue, "number" | "origin">): string {
  return `${issue.origin?.key ?? ""}#${issue.number}`;
}

/** Board lanes in pipeline order. Repair shares the Review lane and carries a badge instead. */
export const FACTORY_LANES = [
  "queued",
  "planning",
  "building",
  "review",
  "merging",
  "blocked",
] as const;
export type FactoryLane = (typeof FACTORY_LANES)[number];

export function factoryLane(stage: FactoryStage): FactoryLane {
  return stage === "repair" ? "review" : stage;
}

export interface FactoryLaneGroup {
  lane: FactoryLane;
  issues: FactoryIssue[];
}

/** Every lane, always present so the board keeps its shape when a lane is empty. */
export function factoryLanes(issues: readonly FactoryIssue[]): FactoryLaneGroup[] {
  return FACTORY_LANES.map((lane) => ({
    lane,
    issues: issues.filter((issue) => factoryLane(issue.stage) === lane),
  }));
}

/** The five-box track on every card. Deploy is not reported by the queue, so it stays pending. */
export const FACTORY_TRACK_STEPS = ["plan", "build", "review", "merge", "deploy"] as const;
export type FactoryTrackStep = (typeof FACTORY_TRACK_STEPS)[number];
export type FactoryTrackState = "done" | "active" | "pending" | "failed" | "blocked";

export function factoryTrack(issue: Pick<FactoryIssue, "stage" | "pr">): FactoryTrackState[] {
  const progress = (doneCount: number, current: FactoryTrackState | null) =>
    FACTORY_TRACK_STEPS.map((_, index): FactoryTrackState => {
      if (index < doneCount) return "done";
      if (index === doneCount && current) return current;
      return "pending";
    });
  switch (issue.stage) {
    case "queued":
      return progress(0, null);
    case "planning":
      return progress(0, "active");
    case "building":
      return progress(1, "active");
    case "review":
      return progress(2, "active");
    case "repair":
      return progress(2, "failed");
    case "merging":
      return progress(3, "active");
    case "blocked":
      // A pull request means the work was built and stopped at review; otherwise it never started.
      return issue.pr ? progress(2, "blocked") : progress(0, "blocked");
  }
}

// ---------------------------------------------------------------------------------------------
// Usage and cost

/** Work categories that consume tokens, in fixed legend and color order. */
export const FACTORY_CATEGORIES = [
  "triage",
  "planning",
  "build",
  "review",
  "repair",
  "release",
  "mechanic",
] as const;
export type FactoryCategory = (typeof FACTORY_CATEGORIES)[number];

export function roleCategory(role: ProjectFactoryState["roles"][number]["role"]): FactoryCategory {
  switch (role) {
    case "factory-triage":
      return "triage";
    case "factory-intake":
      return "planning";
    case "factory-builds":
    case "factory-releases":
      return "release";
    case "factory-mechanic":
      return "mechanic";
  }
}

export function issueAgentCategory(
  role: FactoryIssue["agents"][number]["role"],
  stage: FactoryStage,
): FactoryCategory {
  if (role === "lead") return "planning";
  if (role === "reviewer") return "review";
  return stage === "repair" ? "repair" : "build";
}

/** What the overview knows about one agent thread. */
export interface FactoryAgentInfo {
  provider: string | null;
  usage: AgentUsage | undefined;
  createdAt: Date | null;
}
/** Agents live per host, so a lookup names the host that owns the thread. */
export type FactoryAgentLookup = (
  agentId: string,
  serverId: string,
) => FactoryAgentInfo | undefined;

/** A role thread of one Factory, for usage totals across Factories. */
export interface FactoryRoleThread {
  serverId: string;
  role: ProjectFactoryState["roles"][number]["role"];
  agentId: string | null;
}

/** Totals stay null when no agent reported the value, so the interface renders "—", not 0. */
export interface UsageTotals {
  tokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  /** Some of the cost is estimated from list prices: API-equivalent dollars, not cash. */
  estimated: boolean;
}

export const EMPTY_USAGE: UsageTotals = {
  tokens: null,
  cachedTokens: null,
  costUsd: null,
  estimated: false,
};

function add(total: number | null, value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return total;
  return (total ?? 0) + value;
}

export function addUsage(total: UsageTotals, usage: AgentUsage | undefined): UsageTotals {
  if (!usage) return total;
  const hasTokens = usage.inputTokens !== undefined || usage.outputTokens !== undefined;
  const cost = usage.totalCostUsd ?? usage.estimatedCostUsd;
  return {
    tokens: hasTokens
      ? add(add(total.tokens, usage.inputTokens), usage.outputTokens)
      : total.tokens,
    cachedTokens: add(total.cachedTokens, usage.cachedInputTokens),
    costUsd: add(total.costUsd, cost),
    estimated:
      total.estimated || (usage.totalCostUsd === undefined && usage.estimatedCostUsd !== undefined),
  };
}

export interface FactoryProviderSpend {
  provider: string;
  usage: UsageTotals;
  agents: number;
}

export interface FactoryUsageSummary {
  total: UsageTotals;
  byCategory: Record<FactoryCategory, UsageTotals>;
  byProvider: FactoryProviderSpend[];
  /** Keyed by {@link factoryIssueKey}. */
  byIssue: Map<string, UsageTotals>;
  /** When each issue's first known thread started; null when no thread is loaded. */
  startedAt: Map<string, Date | null>;
}

/** Usage of every Factory thread the client has loaded: issue agents and role agents. */
export function factoryUsage(
  issues: readonly FactoryIssue[],
  roles: readonly FactoryRoleThread[],
  lookup: FactoryAgentLookup,
  /** The host of issues without an origin: the single Factory's host. */
  serverId: string,
): FactoryUsageSummary {
  const byCategory = Object.fromEntries(
    FACTORY_CATEGORIES.map((category) => [category, EMPTY_USAGE]),
  ) as Record<FactoryCategory, UsageTotals>;
  const providers = new Map<string, FactoryProviderSpend>();
  const byIssue = new Map<string, UsageTotals>();
  const startedAt = new Map<string, Date | null>();
  let total = EMPTY_USAGE;
  const seen = new Set<string>();
  const count = (agentId: string, host: string, category: FactoryCategory) => {
    if (seen.has(`${host}:${agentId}`)) return;
    seen.add(`${host}:${agentId}`);
    const info = lookup(agentId, host);
    if (!info) return;
    total = addUsage(total, info.usage);
    byCategory[category] = addUsage(byCategory[category], info.usage);
    const key = info.provider ?? "unknown";
    const entry = providers.get(key) ?? { provider: key, usage: EMPTY_USAGE, agents: 0 };
    providers.set(key, {
      ...entry,
      usage: addUsage(entry.usage, info.usage),
      agents: entry.agents + 1,
    });
  };
  for (const issue of issues) {
    let issueTotal = EMPTY_USAGE;
    let first: Date | null = null;
    const host = issue.origin?.serverId ?? serverId;
    for (const agent of issue.agents) {
      count(agent.agentId, host, issueAgentCategory(agent.role, issue.stage));
      const info = lookup(agent.agentId, host);
      issueTotal = addUsage(issueTotal, info?.usage);
      if (info?.createdAt && (!first || info.createdAt < first)) first = info.createdAt;
    }
    byIssue.set(factoryIssueKey(issue), issueTotal);
    startedAt.set(factoryIssueKey(issue), first);
  }
  for (const role of roles) {
    if (role.agentId) count(role.agentId, role.serverId, roleCategory(role.role));
  }
  const byProvider = [...providers.values()].sort(
    (a, b) => (b.usage.costUsd ?? 0) - (a.usage.costUsd ?? 0),
  );
  return { total, byCategory, byProvider, byIssue, startedAt };
}

// ---------------------------------------------------------------------------------------------
// Queue figures

export interface FactoryQueueFigures {
  counts: Record<FactoryLane, number>;
  inFlight: number;
  repairs: number;
  /** Share of pull requests with finished checks that pass; null when none have finished. */
  checkPassRate: number | null;
  checksFinished: number;
}

export function factoryQueueFigures(issues: readonly FactoryIssue[]): FactoryQueueFigures {
  const counts = Object.fromEntries(FACTORY_LANES.map((lane) => [lane, 0])) as Record<
    FactoryLane,
    number
  >;
  let passing = 0;
  let finished = 0;
  for (const issue of issues) {
    counts[factoryLane(issue.stage)] += 1;
    const checks = issue.pr?.checks;
    if (checks === "passing" || checks === "failing") {
      finished += 1;
      if (checks === "passing") passing += 1;
    }
  }
  return {
    counts,
    inFlight: issues.filter((issue) => issue.stage !== "queued" && issue.stage !== "blocked")
      .length,
    repairs: issues.filter((issue) => issue.stage === "repair").length,
    checkPassRate: finished ? passing / finished : null,
    checksFinished: finished,
  };
}

// ---------------------------------------------------------------------------------------------
// Formatting: missing values render "—", never 0.

export const MISSING = "—";

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}K`;
  return Math.round(value).toLocaleString("en-US");
}

function trim(value: number): string {
  return value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  if (value >= 1000) return `$${formatCompact(value)}`;
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return `${Math.round(value * 100)}%`;
}

export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return MISSING;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${trim(hours)}h`;
  return `${trim(hours / 24)}d`;
}

export function hoursSince(date: Date | null, now: number): number | null {
  return date ? Math.max(0, (now - date.getTime()) / 3_600_000) : null;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Day labels for a series ending today, oldest first, such as "Nov 1". */
export function dayLabels(count: number, now: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now - (count - 1 - index) * 86_400_000);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  });
}

// ---------------------------------------------------------------------------------------------
// Which reports are backed by sample data

/**
 * Every figure and panel the designs can show, marked true when its value comes from sample
 * history the daemon does not record yet. Live mode shows only the false ones, so no sample value
 * ever appears beside live data; Sample factory mode shows them all, tagged.
 */
export const FACTORY_REPORTS = {
  // Figures
  inFlight: false,
  merged7d: true,
  cycleTime: true,
  tokens: false,
  spend: false,
  monthCap: true,
  passRate: false,
  costPerPr: true,
  queueAge: true,
  // Panels
  velocityChart: true,
  costPerPrChart: true,
  tokenHistoryChart: true,
  budgets: true,
  accountPicks: true,
  categories: false,
  quota: false,
  providerSpend: false,
  ledger: false,
} as const satisfies Record<string, boolean>;
export type FactoryReport = keyof typeof FACTORY_REPORTS;

function reportOf(item: FactoryReport | { report: FactoryReport }): FactoryReport {
  return typeof item === "string" ? item : item.report;
}

/** The reports to render: all of them in Sample factory mode, only live-backed ones in Live. */
export function shownReports<Item extends { report: FactoryReport } | FactoryReport>(
  items: readonly Item[],
  sample: boolean,
): Item[] {
  if (sample) return [...items];
  return items.filter((item) => !FACTORY_REPORTS[reportOf(item)]);
}
