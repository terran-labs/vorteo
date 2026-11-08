import type { AgentQuestion } from "@getpaseo/protocol/agent-questions";
import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import { groupQuestions } from "@/open-questions/model";
import type { Agent } from "@/stores/session-store";
import { isOwnerStop } from "./factory-reads";
import { FACTORY_LANES, factoryLane, type FactoryIssue, type FactoryLane } from "./overview-model";

/**
 * Pure model for overviews that span several Factories: every project's Factory on every host
 * of the installation, and everything waiting on the owner across them.
 */

export type FactoryDrain = NonNullable<ProjectFactoryState["drain"]>;

/** One project's Factory on one host, as far as the client has loaded it. */
export interface FactoryScopeEntry {
  key: string;
  serverId: string;
  projectId: string;
  name: string;
  /** Shown only when the overview spans more than one host. */
  hostLabel: string | null;
  /** Full state once loaded; the list entry alone is enough to show the pill. */
  state: ProjectFactoryState | null;
  status: ProjectFactoryState["state"];
  /** Set while pause_all holds this project. */
  drain: FactoryDrain | null;
  /** Null until loaded, or when the daemon has no queue. */
  issues: FactoryIssue[] | null;
}

export function factoryScopeKey(serverId: string, projectId: string): string {
  return `${serverId}:${projectId}`;
}

/** Every loaded issue, tagged with the Factory it belongs to. */
export function scopedIssues(entries: readonly FactoryScopeEntry[]): FactoryIssue[] {
  return entries.flatMap((entry) =>
    (entry.issues ?? []).map(
      (issue): FactoryIssue =>
        Object.assign({}, issue, {
          origin: {
            key: entry.key,
            serverId: entry.serverId,
            projectId: entry.projectId,
            label: entry.name,
          },
        }),
    ),
  );
}

/** Issues per lane across every queue; queues still loading count as empty. */
export function aggregateStageCounts(
  queues: readonly (readonly FactoryIssue[] | null | undefined)[],
): Record<FactoryLane, number> {
  const counts = Object.fromEntries(FACTORY_LANES.map((lane) => [lane, 0])) as Record<
    FactoryLane,
    number
  >;
  for (const queue of queues) {
    for (const issue of queue ?? []) counts[factoryLane(issue.stage)] += 1;
  }
  return counts;
}

/** One pause_all on one host. The daemon gives each project its own drain id. */
export interface FactoryStop {
  key: string;
  serverId: string;
  reason: string;
  /** The earliest project's pause. */
  pausedAt: string;
  projects: number;
  /** Started by Stop all Factories; otherwise someone else, such as Builds, holds it. */
  owner: boolean;
}

function drainOf(entry: FactoryScopeEntry): FactoryDrain | null {
  return entry.drain ?? entry.state?.drain ?? null;
}

/** Stops holding Factories, one per host and reason, however many projects each holds. */
export function activeDrains(entries: readonly FactoryScopeEntry[]): FactoryStop[] {
  const stops = new Map<string, FactoryStop>();
  for (const entry of entries) {
    const drain = drainOf(entry);
    if (!drain) continue;
    const key = `${entry.serverId}:${drain.reason}`;
    const current = stops.get(key);
    stops.set(key, {
      key,
      serverId: entry.serverId,
      reason: drain.reason,
      pausedAt: current && current.pausedAt < drain.pausedAt ? current.pausedAt : drain.pausedAt,
      projects: (current?.projects ?? 0) + 1,
      owner: isOwnerStop(drain),
    });
  }
  return [...stops.values()];
}

/** What one host's Factories allow the global stop control to do. */
export interface HostStopState {
  /** Some Factory is on and not stopped, so Stop all has something to stop. */
  running: boolean;
  /** Stop all holds some Factory. */
  ours: boolean;
  /** Someone else, such as Builds before a restart, holds some Factory. */
  foreign: boolean;
}

/**
 * Read from scope entries, or list entries with their state as status. resume_all releases every drain on a host, so a host
 * with any foreign drain is never resumed, and never stopped again on top of it.
 */
export function hostStopState(
  projects: readonly { status: string; drain?: { reason: string } | null }[],
): HostStopState {
  let running = false;
  let ours = false;
  let foreign = false;
  for (const project of projects) {
    if (project.drain) {
      if (isOwnerStop(project.drain)) ours = true;
      else foreign = true;
    } else if (project.status === "on") {
      running = true;
    }
  }
  return { running, ours, foreign };
}

export function canStopHost(state: HostStopState): boolean {
  return state.running && !state.foreign;
}

export function canResumeHost(state: HostStopState): boolean {
  return state.ours && !state.foreign;
}

/**
 * Which hosts a confirmed Stop all or Resume all may act on, from a fresh list read of each.
 * A host whose read failed is never acted on, and one that no longer qualifies is skipped; the
 * rest proceed, so one unreachable host does not stop the others.
 */
export function selectFreshTargets<Host>(
  targets: readonly Host[],
  reads: readonly PromiseSettledResult<{
    projects: readonly { state: string; drain: { reason: string } | null }[];
  }>[],
  qualifies: (state: HostStopState) => boolean,
): { act: Host[]; unreadable: Host[]; skipped: Host[] } {
  const act: Host[] = [];
  const unreadable: Host[] = [];
  const skipped: Host[] = [];
  targets.forEach((host, index) => {
    const read = reads[index];
    if (!read || read.status === "rejected") {
      unreadable.push(host);
      return;
    }
    const state = hostStopState(
      read.value.projects.map((project) => ({ status: project.state, drain: project.drain })),
    );
    (qualifies(state) ? act : skipped).push(host);
  });
  return { act, unreadable, skipped };
}

// ---------------------------------------------------------------------------------------------
// Needs you

/** Most urgent first: answers and instruction proposals hold work until the owner acts. */
export const NEEDS_YOU_KINDS = [
  "question",
  "proposal",
  "drain",
  "humanReview",
  "failingChecks",
  "claim",
  "awaitingApproval",
  "blocked",
] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

export type NeedsYouAction =
  | { kind: "thread"; serverId: string; agentId: string }
  | { kind: "issue"; url: string; prUrl: string | null }
  | {
      kind: "instructions";
      serverId: string;
      projectId: string;
      role: ProjectFactoryState["roles"][number]["role"];
    }
  /** Shown only; the banner owns resuming, behind a confirmation. */
  | { kind: "stop" };

export interface NeedsYouItem {
  key: string;
  kind: NeedsYouKind;
  /** The question, issue title, role name or drain reason, as written. */
  subject: string;
  /** Issue number for issue items. */
  number: number | null;
  factoryKey: string;
  projectLabel: string;
  serverId: string;
  projectId: string;
  /** When it started waiting; null when unknown. */
  at: string | null;
  action: NeedsYouAction;
}

/** An open question asked by a Factory thread. */
export interface FactoryQuestion {
  factoryKey: string;
  serverId: string;
  agentId: string;
  question: AgentQuestion;
}

type QuestionAgent = Pick<Agent, "id" | "workspaceId" | "archivedAt" | "questions">;

/**
 * Open questions from the threads of these Factories: role threads, threads in role workspaces
 * and the lead, worker and reviewer threads of their issues. Archived threads are left out, as
 * in the open-questions card.
 */
export function factoryQuestions(
  entries: readonly FactoryScopeEntry[],
  hosts: readonly {
    serverId: string;
    agents: Iterable<QuestionAgent>;
    pendingArchive: ReadonlySet<string>;
  }[],
): FactoryQuestion[] {
  const questions: FactoryQuestion[] = [];
  for (const host of hosts) {
    const owners = new Map<string, string>();
    const workspaces = new Map<string, string>();
    for (const entry of entries) {
      if (entry.serverId !== host.serverId) continue;
      for (const role of entry.state?.roles ?? []) {
        if (role.agentId) owners.set(role.agentId, entry.key);
        if (role.workspaceId) workspaces.set(role.workspaceId, entry.key);
      }
      for (const issue of entry.issues ?? []) {
        for (const agent of issue.agents) owners.set(agent.agentId, entry.key);
      }
    }
    for (const agent of host.agents) {
      if (agent.archivedAt || host.pendingArchive.has(agent.id)) continue;
      const factoryKey =
        owners.get(agent.id) ?? (agent.workspaceId ? workspaces.get(agent.workspaceId) : undefined);
      if (!factoryKey) continue;
      for (const question of groupQuestions(agent.questions ?? []).open) {
        questions.push({ factoryKey, serverId: host.serverId, agentId: agent.id, question });
      }
    }
  }
  return questions;
}

function issueKind(issue: FactoryIssue): NeedsYouKind | null {
  if (issue.label === "human-review") return "humanReview";
  const checks = issue.pr?.checks;
  if (checks === "failing" && issue.stage !== "repair" && issue.stage !== "blocked") {
    return "failingChecks";
  }
  if (issue.claim && !issue.claim.local) return "claim";
  if (issue.stage === "blocked") return "blocked";
  const reviewing = issue.agents.some(
    (agent) =>
      agent.role === "reviewer" && (agent.status === "running" || agent.status === "initializing"),
  );
  if (
    issue.stage === "review" &&
    checks === "passing" &&
    issue.pr?.reviewDecision === "REVIEW_REQUIRED" &&
    !reviewing
  ) {
    return "awaitingApproval";
  }
  return null;
}

/** Everything waiting on the owner, most urgent first, then longest waiting. */
export function collectNeedsYou(input: {
  entries: readonly FactoryScopeEntry[];
  questions: readonly FactoryQuestion[];
}): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const byKey = new Map(input.entries.map((entry) => [entry.key, entry]));
  for (const { factoryKey, serverId, agentId, question } of input.questions) {
    const entry = byKey.get(factoryKey);
    if (!entry) continue;
    items.push({
      key: `question:${serverId}:${question.id}`,
      kind: "question",
      subject: question.question,
      number: null,
      factoryKey,
      projectLabel: entry.name,
      serverId,
      projectId: entry.projectId,
      at: question.askedAt,
      action: { kind: "thread", serverId, agentId },
    });
  }
  for (const stop of activeDrains(input.entries)) {
    const entry = input.entries.find(
      (candidate) =>
        candidate.serverId === stop.serverId && drainOf(candidate)?.reason === stop.reason,
    )!;
    items.push({
      key: `stop:${stop.key}`,
      kind: "drain",
      subject: stop.reason,
      number: null,
      factoryKey: entry.key,
      projectLabel: entry.hostLabel ?? entry.name,
      serverId: stop.serverId,
      projectId: entry.projectId,
      at: stop.pausedAt,
      action: { kind: "stop" },
    });
  }
  for (const entry of input.entries) {
    const base = {
      factoryKey: entry.key,
      projectLabel: entry.name,
      serverId: entry.serverId,
      projectId: entry.projectId,
    };
    for (const role of entry.state?.roles ?? []) {
      // "needed" is the Mechanic's own review; only a proposal waits for the owner.
      if (role.instructions.review !== "proposed") continue;
      items.push({
        ...base,
        key: `instructions:${entry.key}:${role.role}`,
        kind: "proposal",
        subject: role.title,
        number: null,
        at: null,
        action: {
          kind: "instructions",
          serverId: entry.serverId,
          projectId: entry.projectId,
          role: role.role,
        },
      });
    }
    for (const issue of entry.issues ?? []) {
      const kind = issueKind(issue);
      if (!kind) continue;
      items.push({
        ...base,
        key: `issue:${entry.key}#${issue.number}`,
        kind,
        subject: issue.title,
        number: issue.number,
        at: null,
        action: { kind: "issue", url: issue.url, prUrl: issue.pr?.url ?? null },
      });
    }
  }
  return items.sort(compareNeedsYou);
}

function compareNeedsYou(left: NeedsYouItem, right: NeedsYouItem): number {
  const rank = NEEDS_YOU_KINDS.indexOf(left.kind) - NEEDS_YOU_KINDS.indexOf(right.kind);
  if (rank) return rank;
  if (left.at && right.at) return left.at.localeCompare(right.at);
  if (left.at) return -1;
  if (right.at) return 1;
  return 0;
}

/** Needs-you items per Factory, for the per-Factory strip. */
export function needsYouByFactory(items: readonly NeedsYouItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.factoryKey, (counts.get(item.factoryKey) ?? 0) + 1);
  return counts;
}
