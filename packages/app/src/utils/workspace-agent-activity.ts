import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
  /** Set when every unarchived agent in the workspace works one Factory issue. */
  factoryIssue?: WorkspaceFactoryIssue;
}

/** A Factory issue workspace: its issue and the Factory that owns it, from its agents' labels. */
export interface WorkspaceFactoryIssue {
  issue: number;
  /** `<serverId>/<projectId>` of the owning Factory, or null when the agents do not name one. */
  installation: string | null;
}

/**
 * The issue every unarchived agent in each workspace carries in its `factory.issue` label, keyed by
 * workspace. A workspace with any agent outside one issue is absent.
 */
function factoryIssuesByWorkspace(agents: ReadonlyMap<string, Agent>) {
  const issues = new Map<string, WorkspaceFactoryIssue | null>();
  for (const agent of agents.values()) {
    if (agent.archivedAt || !agent.workspaceId) continue;
    const issue = Number(agent.labels["factory.issue"]);
    const current = issues.get(agent.workspaceId);
    if (current === null) continue;
    if (!Number.isInteger(issue) || issue <= 0 || (current && current.issue !== issue)) {
      issues.set(agent.workspaceId, null);
      continue;
    }
    if (!current) {
      issues.set(agent.workspaceId, {
        issue,
        installation: agent.labels["factory.installation"] ?? null,
      });
    }
  }
  return issues;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  const latestActivityAtByWorkspaceId = new Map<string, Date>();
  const factoryIssues = factoryIssuesByWorkspace(agents);

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestActivityAt = latestActivityAtByWorkspaceId.get(agent.workspaceId);
    if (latestActivityAt && enteredAt <= latestActivityAt) {
      continue;
    }
    latestActivityAtByWorkspaceId.set(agent.workspaceId, enteredAt);

    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    const factoryIssue = factoryIssues.get(agent.workspaceId) ?? undefined;
    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
      ...(factoryIssue ? { factoryIssue } : {}),
    });
  }

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    const previousActivity = previous?.get(workspaceId);
    if (previousActivity && isSameActivity(previousActivity, activity)) {
      activityByWorkspaceId.set(workspaceId, previousActivity);
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

/** Same agent, status and Factory issue: the previous object can be kept for identity. */
function isSameActivity(previous: WorkspaceAgentActivity, next: WorkspaceAgentActivity): boolean {
  return (
    previous.agentId === next.agentId &&
    previous.status === next.status &&
    previous.factoryIssue?.issue === next.factoryIssue?.issue &&
    previous.factoryIssue?.installation === next.factoryIssue?.installation
  );
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}
