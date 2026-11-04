import {
  PROJECT_FACTORY_ROLE_IDS,
  fallbackFactoryRoleTitle,
} from "@/components/sidebar/factory-role-ids";
import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";

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
  states: readonly {
    serverId: string;
    projectId: string;
    roles: readonly { workspaceId: string | null }[];
  }[] = [],
) {
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
  for (const workspace of workspaces) {
    const entry = entries.get(workspace.workspaceKey);
    const mechanic =
      entry?.systemMembership?.role === "optimization-runner" &&
      projectHosts.has(JSON.stringify([entry.serverId, entry.projectId]));
    const supported = supportedHosts.get(workspace.serverId) === true;
    if (
      (supported && entry?.factoryMembership?.installationId.startsWith("project-factory:")) ||
      mechanic
    )
      factory.push(workspace);
    else remaining.push(workspace);
  }
  const roles = PROJECT_FACTORY_ROLE_IDS;
  const rank = (workspace: SidebarWorkspacePlacement) => {
    const entry = entries.get(workspace.workspaceKey);
    const state = states.find(
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
    if (previous && previous.installationId !== membership.installationId) ambiguous.add(key);
    targets.set(key, {
      serverId: membership.serverId,
      projectId: membership.projectId,
      installationId: membership.installationId,
    });
  }
  return Array.from(targets.entries())
    .filter(([key]) => !ambiguous.has(key))
    .map(([, target]) => target);
}
