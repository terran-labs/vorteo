import type { ProjectFactoryState } from "@/components/sidebar/factory-state";
import {
  PROJECT_FACTORY_ROLE_IDS,
  fallbackFactoryRoleTitle,
} from "@/components/sidebar/factory-role-ids";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";

type FactoryWorkspaceState = Pick<ProjectFactoryState, "serverId" | "projectId" | "state"> & {
  roles: readonly { workspaceId: string | null }[];
};
function hasProjectFactory(state: FactoryWorkspaceState): boolean {
  if (state.state === "on" || state.state === "paused") return true;
  return state.state === "unavailable" && state.roles.some((role) => role.workspaceId !== null);
}

export function splitStandingWorkspaces(
  workspaces: readonly SidebarWorkspacePlacement[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
) {
  const work: SidebarWorkspacePlacement[] = [];
  const standing: SidebarWorkspacePlacement[] = [];
  for (const workspace of workspaces) {
    const group = entries.get(workspace.workspaceKey)?.standing ? standing : work;
    group.push(workspace);
  }
  return { work, standing };
}

export function splitFactoryWorkspaces(
  workspaces: readonly SidebarWorkspacePlacement[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  supportedHosts: ReadonlyMap<string, boolean>,
  states: readonly FactoryWorkspaceState[] = [],
) {
  const activeStates = states.filter(hasProjectFactory);
  const factory: SidebarWorkspacePlacement[] = [];
  const remaining: SidebarWorkspacePlacement[] = [];
  const projectHosts = new Set(
    workspaces.flatMap((workspace) => {
      const entry = entries.get(workspace.workspaceKey);
      return supportedHosts.get(workspace.serverId) &&
        entry?.factoryMembership?.installationId.startsWith("project-factory:")
        ? [JSON.stringify([entry.serverId, entry.projectId])]
        : [];
    }),
  );
  for (const state of activeStates) {
    projectHosts.add(JSON.stringify([state.serverId, state.projectId]));
  }
  for (const workspace of workspaces) {
    const entry = entries.get(workspace.workspaceKey);
    const state = activeStates.find(
      (candidate) =>
        candidate.serverId === workspace.serverId && candidate.projectId === entry?.projectId,
    );
    const roleMember = state?.roles.some((role) => role.workspaceId === workspace.workspaceId);
    const projectHasFactory = projectHosts.size > 0;
    const supported = supportedHosts.get(workspace.serverId) === true;
    const nativeMember =
      supported && entry?.factoryMembership?.installationId.startsWith("project-factory:");
    const standingMember = projectHasFactory && entry?.standing;
    const systemMechanic =
      !state && projectHasFactory && entry?.systemMembership?.role === "optimization-runner";
    if (roleMember || nativeMember || standingMember || systemMechanic) factory.push(workspace);
    else remaining.push(workspace);
  }
  const roles = PROJECT_FACTORY_ROLE_IDS;
  const rank = (workspace: SidebarWorkspacePlacement) => {
    const entry = entries.get(workspace.workspaceKey);
    const state = activeStates.find(
      (candidate) =>
        candidate.serverId === workspace.serverId && candidate.projectId === entry?.projectId,
    );
    if (state) {
      const index = state.roles.findIndex((role) => role.workspaceId === workspace.workspaceId);
      return index < 0 ? state.roles.length : index;
    }
    // Display-only fallback until daemon state arrives. Membership is established above.
    if (entry?.systemMembership?.role === "optimization-runner")
      return roles.indexOf("factory-mechanic");
    if (!entry?.factoryMembership?.installationId.startsWith("project-factory:"))
      return roles.length;
    const title = entry?.title ?? entry?.name ?? "";
    const index = roles.findIndex((role) => title.endsWith(`:: ${fallbackFactoryRoleTitle(role)}`));
    return index < 0 ? roles.length : index;
  };
  factory.sort((a, b) => rank(a) - rank(b));
  return { ...splitStandingWorkspaces(remaining, entries), factory };
}

/** Native members determine observation routes even when a project spans hosts. */
export function factoryOverviewTargets(
  workspaces: readonly SidebarWorkspacePlacement[],
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>,
  availableHosts: ReadonlySet<string>,
  states: readonly FactoryWorkspaceState[] = [],
) {
  const targets = new Map<
    string,
    { serverId: string; projectId: string; installationId: string }
  >();
  const ambiguous = new Set<string>();
  for (const workspace of workspaces) {
    const entry = entries.get(workspace.workspaceKey);
    const membership = entry?.factoryMembership;
    if (
      !membership ||
      !availableHosts.has(workspace.serverId) ||
      membership.serverId !== workspace.serverId ||
      entry?.serverId !== workspace.serverId
    )
      continue;
    const key = JSON.stringify([membership.serverId, membership.projectId]);
    const previous = targets.get(key);
    const currentIsProjectFactory = membership.installationId.startsWith("project-factory:");
    const previousIsProjectFactory = previous?.installationId.startsWith("project-factory:");
    if (previousIsProjectFactory && !currentIsProjectFactory) continue;
    if (currentIsProjectFactory && !previousIsProjectFactory) {
      ambiguous.delete(key);
    }
    if (
      previous &&
      previousIsProjectFactory === currentIsProjectFactory &&
      previous.installationId !== membership.installationId
    )
      ambiguous.add(key);
    targets.set(key, {
      serverId: membership.serverId,
      projectId: membership.projectId,
      installationId: membership.installationId,
    });
  }
  for (const state of states) {
    if (!availableHosts.has(state.serverId) || !hasProjectFactory(state)) continue;
    const key = JSON.stringify([state.serverId, state.projectId]);
    targets.set(key, {
      serverId: state.serverId,
      projectId: state.projectId,
      installationId: `project-factory:${state.projectId}`,
    });
    ambiguous.delete(key);
  }
  return Array.from(targets.entries())
    .filter(([key]) => !ambiguous.has(key))
    .map(([, target]) => target);
}
