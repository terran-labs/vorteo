import { workspaceEnvironmentMembers, workspaceOwner } from "@/task-environments/workspaces";
import type { SessionState } from "@/stores/session-store";
import type { WorkspaceTabTarget } from "./model";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { getAgentPresentationIndex } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  agentTargets?: Record<string, WorkspaceTabTarget>;
  hydratedEnvironmentIds?: Set<string>;
  foreignAgentIds?: Set<string>;
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
  workspaces?: Map<string, WorkspaceDescriptor>;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!sessionAgents || !workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      foreignAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const foreignAgentIds = new Set<string>();
  const presentations = getAgentPresentationIndex(sessionAgents, input.workspaces);
  for (const agent of sessionAgents.values()) {
    const presentation = presentations.get(agent.id);
    const belongsToExecutionWorkspace =
      normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId;
    const belongsToPresentationWorkspace = presentation?.workspaceId === workspaceId;
    if (!belongsToExecutionWorkspace && !belongsToPresentationWorkspace) {
      if (normalizeWorkspaceOpaqueId(agent.workspaceId)) foreignAgentIds.add(agent.id);
      continue;
    }
    if (!agent.archivedAt) {
      activeAgentIds.add(agent.id);
      // Parent grouping must not make the retained execution workspace unreadable.
      const isExecutionRecovery = belongsToExecutionWorkspace && !belongsToPresentationWorkspace;
      if (presentation?.rootAgentId === agent.id || isExecutionRecovery) {
        autoOpenAgentIds.add(agent.id);
      }
    }
  }
  for (const agent of agentDetails?.values() ?? []) {
    if (sessionAgents?.has(agent.id)) {
      continue;
    }
    const ownerId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (ownerId && ownerId !== workspaceId) {
      foreignAgentIds.add(agent.id);
    }
  }
  return { activeAgentIds, autoOpenAgentIds, foreignAgentIds };
}

interface AgentMapsSnapshot {
  sessions: Record<
    string,
    { agents: Map<string, Agent>; agentDetails: Map<string, Agent> } | undefined
  >;
}

// Session-store selectors run on every store update, including every stream tick, which
// leaves the agent maps untouched. Reuse the previous result until either map changes, and
// keep it when a recompute yields the same sets so the hook's equality check stays O(1).
export function createWorkspaceAgentVisibilitySelector(input: {
  serverId: string;
  workspaceId: string | null | undefined;
}): (state: AgentMapsSnapshot) => WorkspaceAgentVisibility {
  let previousAgents: Map<string, Agent> | undefined;
  let previousAgentDetails: Map<string, Agent> | undefined;
  let previousVisibility: WorkspaceAgentVisibility | null = null;

  return (state) => {
    const session = state.sessions[input.serverId];
    const agents = session?.agents;
    const agentDetails = session?.agentDetails;
    if (previousVisibility && agents === previousAgents && agentDetails === previousAgentDetails) {
      return previousVisibility;
    }

    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: agents,
      agentDetails,
      workspaceId: input.workspaceId,
    });
    previousAgents = agents;
    previousAgentDetails = agentDetails;
    if (!previousVisibility || !workspaceAgentVisibilityEqual(previousVisibility, visibility)) {
      previousVisibility = visibility;
    }
    return previousVisibility;
  };
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingTerminalCreate: boolean;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    agentTargets: input.agentVisibility.agentTargets,
    hydratedEnvironmentIds: input.agentVisibility.hydratedEnvironmentIds,
    foreignAgentIds: input.agentVisibility.foreignAgentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingTerminalCreate: input.hasActivePendingTerminalCreate,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) &&
    setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
    JSON.stringify(a.agentTargets) === JSON.stringify(b.agentTargets) &&
    setsEqual(a.hydratedEnvironmentIds ?? new Set(), b.hydratedEnvironmentIds ?? new Set()) &&
    setsEqual(a.foreignAgentIds ?? new Set(), b.foreignAgentIds ?? new Set())
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}

interface EnvironmentVisibilityInput {
  sessions: Record<
    string,
    Pick<
      SessionState,
      "agents" | "agentDetails" | "workspaces" | "hasHydratedAgents" | "hasHydratedWorkspaces"
    >
  >;
  serverId: string;
  workspaceId: string;
}

export function deriveEnvironmentWorkspaceAgentVisibility(
  input: EnvironmentVisibilityInput,
): WorkspaceAgentVisibility {
  const members = workspaceEnvironmentMembers(input.sessions, input);
  const foreignAgentIds = new Set<string>();
  const combined: WorkspaceAgentVisibility = {
    activeAgentIds: new Set(),
    autoOpenAgentIds: new Set(),
    agentTargets: {},
    foreignAgentIds,
  };
  const targets: Record<string, WorkspaceTabTarget> = {};
  const groupOwnedAgentIds = new Set<string>();
  for (const member of members) {
    const session = input.sessions[member.serverId];
    for (const agent of [
      ...(session?.agents.values() ?? []),
      ...(session?.agentDetails.values() ?? []),
    ]) {
      if (normalizeWorkspaceOpaqueId(agent.workspaceId) === member.workspaceId)
        groupOwnedAgentIds.add(agent.id);
    }
    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: session?.agents,
      agentDetails: session?.agentDetails,
      workspaceId: member.workspaceId,
      // Before workspaces hydrate every parent looks unavailable, which would make each child
      // its own root and open it as a tab for good. Follow the parent chain until then.
      workspaces: session?.hasHydratedWorkspaces ? session.workspaces : undefined,
    });
    for (const agentId of visibility.foreignAgentIds ?? []) foreignAgentIds.add(agentId);
    for (const agentId of visibility.activeAgentIds) combined.activeAgentIds.add(agentId);
    for (const agentId of visibility.autoOpenAgentIds) {
      combined.autoOpenAgentIds.add(agentId);
      const remote = member.serverId !== input.serverId || member.workspaceId !== input.workspaceId;
      targets[agentId] = remote
        ? { kind: "agent", agentId, environment: member }
        : { kind: "agent", agentId };
    }
  }
  // A member can own an agent considered foreign by another member in the same group.
  for (const agentId of [...combined.activeAgentIds, ...groupOwnedAgentIds])
    foreignAgentIds.delete(agentId);
  const { membershipReady, hydratedEnvironmentIds } = workspaceGroupReadiness(input, members);
  // Unknown members may still own a saved tab. Pin removal precedes environment pruning.
  if (!membershipReady) foreignAgentIds.clear();
  combined.hydratedEnvironmentIds = hydratedEnvironmentIds;
  combined.agentTargets = targets;
  return combined;
}

// A destination may hydrate first. Its declared owner and known directories must
// establish group membership before saved foreign pins can be removed.
function workspaceGroupReadiness(
  input: EnvironmentVisibilityInput,
  members: ReturnType<typeof workspaceEnvironmentMembers>,
) {
  const ownerReference = workspaceOwner(
    input,
    input.sessions[input.serverId]?.workspaces.get(input.workspaceId),
  );
  const owner = input.sessions[ownerReference.serverId];
  const ownerWorkspace = owner?.workspaces.get(ownerReference.workspaceId);
  const ownerReady =
    owner?.hasHydratedWorkspaces &&
    ownerWorkspace &&
    !ownerWorkspace.projectMembership?.environmentOwner;
  const membershipReady =
    ownerReady &&
    Object.values(input.sessions).every((session) => session.hasHydratedWorkspaces) &&
    members.every((member) => {
      const session = input.sessions[member.serverId];
      return session?.hasHydratedAgents && session.hasHydratedWorkspaces;
    });
  const hydratedEnvironmentIds = new Set(
    Object.entries(input.sessions)
      .filter(
        ([, session]) => ownerReady && session.hasHydratedAgents && session.hasHydratedWorkspaces,
      )
      .map(([serverId]) => serverId),
  );
  return { membershipReady, hydratedEnvironmentIds };
}

/** Timeline updates retain these maps; avoid rescanning workspaces on every streamed token. */
export function createEnvironmentWorkspaceVisibilitySelector(reference: {
  serverId: string;
  workspaceId: string;
}) {
  let previous: SessionState[] = [];
  let result: WorkspaceAgentVisibility = { activeAgentIds: new Set(), autoOpenAgentIds: new Set() };
  return (state: { sessions: Record<string, SessionState> }) => {
    const sessions = Object.values(state.sessions);
    const unchanged =
      sessions.length === previous.length &&
      sessions.every((session, index) => {
        const old = previous[index];
        return (
          old &&
          session.serverId === old.serverId &&
          session.workspaces === old.workspaces &&
          session.agents === old.agents &&
          session.agentDetails === old.agentDetails &&
          session.hasHydratedAgents === old.hasHydratedAgents &&
          session.hasHydratedWorkspaces === old.hasHydratedWorkspaces
        );
      });
    if (unchanged) return result;
    previous = sessions;
    result = deriveEnvironmentWorkspaceAgentVisibility({ ...reference, sessions: state.sessions });
    return result;
  };
}
