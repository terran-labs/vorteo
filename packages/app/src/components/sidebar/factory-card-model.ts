import type { TFunction } from "i18next";
import { isOwnerStop } from "@/screens/factory/factory-reads";
import type { FactoryQueue } from "@/screens/factory/queue";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { factoryIssueOwner, factoryOverviewTargets } from "@/workspace/lifecycle/grouping";
import type { ProjectFactoryState } from "./factory-state";
import { factoryOverviewRoute } from "./project-factory-model";

/** Identifies one project's Factory on one host. */
export function factoryCardKey(serverId: string, projectId: string): string {
  return `${serverId}:${projectId}`;
}

/**
 * Which Factory overview a pathname shows: `/h/<server>/factory` is All Factories (projectId
 * null) and `/h/<server>/factory/<project>` is one project's, as is its `/settings` page.
 * Anything else is null.
 */
export function factoryOverviewPathTarget(
  pathname: string | null | undefined,
): { serverId: string; projectId: string | null } | null {
  const match = /^\/h\/([^/]+)\/factory(?:\/([^/]+)(?:\/settings)?)?\/?$/.exec(pathname ?? "");
  if (!match) return null;
  try {
    return {
      serverId: decodeURIComponent(match[1]!),
      projectId: match[2] ? decodeURIComponent(match[2]) : null,
    };
  } catch {
    return null;
  }
}

export type FactoryQueueIssue = FactoryQueue["issues"][number];
export type FactoryQueueStage = FactoryQueueIssue["stage"];

/** Stage bar segments, left to right. Repair also counts blocked issues. */
export const FACTORY_STAGE_SEGMENTS = [
  "queued",
  "planning",
  "building",
  "review",
  "repair",
  "merging",
] as const;
export type FactoryStageSegment = (typeof FACTORY_STAGE_SEGMENTS)[number];

export interface FactoryStageCount<Issue extends FactoryQueueIssue = FactoryQueueIssue> {
  segment: FactoryStageSegment;
  count: number;
  issues: Issue[];
}

export function factoryStageSegment(stage: FactoryQueueStage): FactoryStageSegment {
  return stage === "blocked" ? "repair" : stage;
}

/** Non-empty stage segments in bar order. */
export function factoryStageCounts<Issue extends FactoryQueueIssue>(
  issues: readonly Issue[],
): FactoryStageCount<Issue>[] {
  return FACTORY_STAGE_SEGMENTS.flatMap((segment) => {
    const matching = issues.filter((issue) => factoryStageSegment(issue.stage) === segment);
    return matching.length > 0 ? [{ segment, count: matching.length, issues: matching }] : [];
  });
}

/** The runner track's five steps. */
export const FACTORY_TRACK_STEPS = ["plan", "build", "review", "merge", "deploy"] as const;
export type FactoryTrackStep = (typeof FACTORY_TRACK_STEPS)[number];
export type FactoryTrackBox = "done" | "current" | "danger" | "pending";

export interface FactoryRunnerTrack {
  boxes: FactoryTrackBox[];
  /** The lit step, or null for a queued issue. */
  step: FactoryTrackStep | null;
  /** The step needs repair or is blocked. */
  danger: boolean;
}

/** A blocked issue stops where its evidence last places it. */
function blockedStep(issue: Pick<FactoryQueueIssue, "pr" | "agents">): FactoryTrackStep {
  if (issue.pr || issue.agents.some((agent) => agent.role === "reviewer")) return "review";
  if (issue.agents.some((agent) => agent.role === "worker")) return "build";
  return "plan";
}

export function factoryRunnerTrack(
  issue: Pick<FactoryQueueIssue, "stage" | "pr" | "agents">,
): FactoryRunnerTrack {
  const stepByStage: Record<FactoryQueueStage, FactoryTrackStep | null> = {
    queued: null,
    planning: "plan",
    building: "build",
    review: "review",
    repair: "review",
    merging: "merge",
    blocked: blockedStep(issue),
  };
  const step = stepByStage[issue.stage];
  const danger = issue.stage === "repair" || issue.stage === "blocked";
  const index = step ? FACTORY_TRACK_STEPS.indexOf(step) : -1;
  const boxes = FACTORY_TRACK_STEPS.map((_, position): FactoryTrackBox => {
    if (position < index) return "done";
    if (position === index) return danger ? "danger" : "current";
    return "pending";
  });
  return { boxes, step, danger };
}

/** An agent doing work now: running, or starting. */
export function isLiveFactoryAgent(agent: Pick<FactoryQueueIssue["agents"][number], "status">) {
  return agent.status === "running" || agent.status === "initializing";
}

/**
 * Active runners: issues with an agent running or starting now. The queue attaches every
 * unarchived thread whatever its status, and a blocked or stalled issue keeps its stage, so
 * neither stage nor attachment says work is happening. Those issues stay in the stage counts.
 */
export function factoryRunners<Issue extends FactoryQueueIssue>(issues: readonly Issue[]): Issue[] {
  return issues.filter((issue) => issue.agents.some(isLiveFactoryAgent));
}

/**
 * The All Factories pipeline line. Each issue lands in one bucket: active when an agent runs,
 * otherwise by stage, and stalled when it is past the queue with nothing running.
 */
export function factoryPipelineCounts(issues: readonly FactoryQueueIssue[]) {
  const counts = { queued: 0, active: 0, stalled: 0, review: 0 };
  for (const issue of issues) {
    if (issue.agents.some(isLiveFactoryAgent)) counts.active += 1;
    else if (issue.stage === "queued") counts.queued += 1;
    else if (issue.stage === "review") counts.review += 1;
    else counts.stalled += 1;
  }
  return counts;
}

/** The agent a runner row opens: a running worker, else the reviewer, else the lead. */
export function factoryRunnerAgent(issue: Pick<FactoryQueueIssue, "agents">) {
  const live = (status: string) => isLiveFactoryAgent({ status });
  return (
    issue.agents.find((agent) => agent.role === "worker" && live(agent.status)) ??
    issue.agents.find((agent) => agent.role === "reviewer") ??
    issue.agents.find((agent) => agent.role === "lead") ??
    issue.agents[0] ??
    null
  );
}

type IssueMember = Pick<SidebarWorkspaceEntry, "factoryIssue" | "statusBucket" | "statusEnteredAt">;

/** Running first, then the latest status change: the workspace a Runners row should open. */
function newestFirst(left: IssueMember, right: IssueMember): number {
  const running =
    Number(right.statusBucket === "running") - Number(left.statusBucket === "running");
  if (running !== 0) return running;
  return (right.statusEnteredAt?.getTime() ?? 0) - (left.statusEnteredAt?.getTime() ?? 0);
}

/**
 * A Factory card's members split into crew and issue workspaces. An issue can have several
 * workspaces, such as a respawned repair worker; each issue keeps all of them, newest first.
 */
export function groupFactoryMembers<Entry extends IssueMember>(members: readonly Entry[]) {
  const crew: Entry[] = [];
  const byIssue = new Map<number, Entry[]>();
  for (const member of members) {
    const issue = member.factoryIssue?.issue;
    if (issue === undefined) {
      crew.push(member);
      continue;
    }
    const list = byIssue.get(issue) ?? [];
    list.push(member);
    byIssue.set(issue, list);
  }
  for (const list of byIssue.values()) list.sort(newestFirst);
  return { crew, byIssue };
}

/**
 * Which workspace each running issue's row opens, and the Idle list: every other issue workspace,
 * so a second workspace for a running issue still shows.
 */
export function factoryIssueRows<Entry extends IssueMember>(
  byIssue: ReadonlyMap<number, readonly Entry[]>,
  running: ReadonlySet<number>,
) {
  const opened = new Map<number, Entry>();
  const idle: Entry[] = [];
  for (const [issue, list] of byIssue) {
    const [first, ...rest] = list;
    if (first && running.has(issue)) opened.set(issue, first);
    else if (first) idle.push(first);
    idle.push(...rest);
  }
  return { opened, idle };
}

/** "Vorteo :: Foreman" and "Vorteo System :: Mechanic" read as "Foreman" and "Mechanic". */
export function factoryShortName(title: string): string {
  const parts = title.split("::");
  return (parts[parts.length - 1] ?? title).trim() || title.trim();
}

export type FactoryStatePill =
  | { label: "on"; variant: "success" }
  | { label: "paused" | "stopped" | "held"; variant: "warning" }
  | { label: "off" | "unavailable"; variant: "muted" };

/** The pill's tooltip detail: the drain or daemon reason, with a held drain named as such. */
export function factoryStateReason(
  state: Pick<ProjectFactoryState, "drain" | "reason">,
  t: TFunction,
): string | undefined {
  if (state.drain && !isOwnerStop(state.drain)) {
    return t("sidebar.factoryCard.heldReason", { reason: state.drain.reason });
  }
  return state.drain?.reason ?? state.reason ?? undefined;
}

export function factoryStatePill(
  state: Pick<ProjectFactoryState, "state" | "drain">,
): FactoryStatePill {
  // Stop all Factories reads "Stopped"; any other drain is held for a restart or update.
  if (state.drain) {
    return { label: isOwnerStop(state.drain) ? "stopped" : "held", variant: "warning" };
  }
  if (state.state === "on") return { label: "on", variant: "success" };
  if (state.state === "paused") return { label: "paused", variant: "warning" };
  return { label: state.state, variant: "muted" };
}

export interface FactoryCardModel {
  key: string;
  serverId: string;
  projectId: string;
  /** Null when the host's Factory plugin cannot open an overview; the card still lists members. */
  installationId: string | null;
  members: SidebarWorkspacePlacement[];
}

interface FactoryPluginLike {
  id: string;
  serverId: string;
  surfaces: readonly { id: string }[];
}

/**
 * One card per Factory host of a project. Members whose host offers no overview still get a
 * card, so their workspaces stay reachable.
 */
export function factoryCardModels(input: {
  members: readonly SidebarWorkspacePlacement[];
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  states: Parameters<typeof factoryOverviewTargets>[3];
  plugins: readonly FactoryPluginLike[];
}): FactoryCardModel[] {
  const { members, entries, states, plugins } = input;
  const factoryPlugin = (serverId: string) =>
    plugins.find((plugin) => plugin.id === "factory" && plugin.serverId === serverId);
  const targets = factoryOverviewTargets(
    members,
    entries,
    new Set(plugins.filter((plugin) => plugin.id === "factory").map((plugin) => plugin.serverId)),
    states,
  ).filter((target) => factoryOverviewRoute(target, factoryPlugin(target.serverId)) !== null);
  // Issue workers belong to the Factory their labels name, which may sit on another host.
  const owner = (member: SidebarWorkspacePlacement) =>
    factoryIssueOwner(member, entries.get(member.workspaceKey));
  const belongs = (member: SidebarWorkspacePlacement, serverId: string, projectId: string) => {
    const issueOwner = owner(member);
    return issueOwner
      ? issueOwner.serverId === serverId && issueOwner.projectId === projectId
      : member.serverId === serverId;
  };
  const cards: FactoryCardModel[] = targets.map((target) => ({
    key: factoryCardKey(target.serverId, target.projectId),
    serverId: target.serverId,
    projectId: target.projectId,
    installationId: target.installationId,
    members: members.filter((member) => belongs(member, target.serverId, target.projectId)),
  }));
  // An issue worker whose owning Factory has no card here, for example no overview on that host.
  const orphans = members.filter(
    (member) => owner(member) !== null && !cards.some((card) => card.members.includes(member)),
  );
  for (const member of members) {
    if (owner(member)) continue;
    if (cards.some((card) => card.serverId === member.serverId)) continue;
    const projectId = entries.get(member.workspaceKey)?.projectId;
    if (!projectId) continue;
    cards.push({
      key: factoryCardKey(member.serverId, projectId),
      serverId: member.serverId,
      projectId,
      installationId: null,
      members: members.filter(
        (candidate) => candidate.serverId === member.serverId && !owner(candidate),
      ),
    });
  }
  // An orphan keeps its own Factory: a card for its owner with no overview, keyed and read by the
  // owner's server and project, so no other Factory's state, queue or Runners row touches it. The
  // owner has no card here by definition, so this never duplicates one.
  for (const member of orphans) {
    const issueOwner = owner(member);
    if (!issueOwner) continue;
    const key = factoryCardKey(issueOwner.serverId, issueOwner.projectId);
    let card = cards.find((candidate) => candidate.key === key);
    if (!card) {
      card = { key, ...issueOwner, installationId: null, members: [] };
      cards.push(card);
    }
    card.members.push(member);
  }
  return cards;
}
