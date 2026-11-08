import type { TFunction } from "i18next";
import { isOwnerStop } from "@/screens/factory/factory-reads";
import type { FactoryQueue } from "@/screens/factory/queue";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { factoryOverviewTargets } from "@/workspace/lifecycle/grouping";
import type { ProjectFactoryState } from "./factory-state";
import { factoryOverviewRoute } from "./project-factory-model";

/** Identifies one project's Factory on one host. */
export function factoryCardKey(serverId: string, projectId: string): string {
  return `${serverId}:${projectId}`;
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

/** Issues a runner is working on: past the queue, or already staffed. */
export function factoryRunners<Issue extends FactoryQueueIssue>(issues: readonly Issue[]): Issue[] {
  return issues.filter((issue) => issue.stage !== "queued" || issue.agents.length > 0);
}

/** The agent a runner row opens: a running worker, else the reviewer, else the lead. */
export function factoryRunnerAgent(issue: Pick<FactoryQueueIssue, "agents">) {
  const live = (status: string) => status === "running" || status === "initializing";
  return (
    issue.agents.find((agent) => agent.role === "worker" && live(agent.status)) ??
    issue.agents.find((agent) => agent.role === "reviewer") ??
    issue.agents.find((agent) => agent.role === "lead") ??
    issue.agents[0] ??
    null
  );
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
    return t("projectFactory.needsYou.kinds.held", { subject: state.drain.reason });
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
  const cards: FactoryCardModel[] = targets.map((target) => ({
    key: factoryCardKey(target.serverId, target.projectId),
    serverId: target.serverId,
    projectId: target.projectId,
    installationId: target.installationId,
    members: members.filter((member) => member.serverId === target.serverId),
  }));
  for (const member of members) {
    if (cards.some((card) => card.serverId === member.serverId)) continue;
    const projectId = entries.get(member.workspaceKey)?.projectId;
    if (!projectId) continue;
    cards.push({
      key: factoryCardKey(member.serverId, projectId),
      serverId: member.serverId,
      projectId,
      installationId: null,
      members: members.filter((candidate) => candidate.serverId === member.serverId),
    });
  }
  return cards;
}
