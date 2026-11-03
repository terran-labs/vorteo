import {
  SIDEBAR_ROOT_CONTAINER,
  sidebarFolderContainerKey,
} from "@getpaseo/protocol/sidebar-folders";
import {
  placeKeysFirst,
  type SidebarPlaceFirst,
  type SidebarStatePatch,
} from "@getpaseo/protocol/sidebar-state";

interface PlacementProject {
  viewKey: string;
  workspaces: readonly { workspaceKey: string }[];
}

/**
 * New projects and workspaces become the first row of the list that holds them. Returns the keys
 * no saved order mentions yet, or null when every visible row already has a saved place.
 */
export function computeSidebarPlacement(input: {
  projects: readonly PlacementProject[];
  projectOrder: readonly string[];
  workspaceOrderByProject: Readonly<Record<string, readonly string[]>>;
}): SidebarPlaceFirst | null {
  const placement: SidebarPlaceFirst = {};
  const childOrder: Record<string, string[]> = {};
  const savedProjects = new Set(input.projectOrder);
  const newProjects = input.projects
    .map((project) => project.viewKey)
    .filter((key) => !savedProjects.has(key));
  if (newProjects.length > 0) {
    placement.projectOrder = newProjects;
    childOrder[SIDEBAR_ROOT_CONTAINER] = newProjects;
  }
  const workspaceOrderByProject: Record<string, string[]> = {};
  for (const project of input.projects) {
    const saved = new Set(input.workspaceOrderByProject[project.viewKey] ?? []);
    const newWorkspaces = project.workspaces
      .map((workspace) => workspace.workspaceKey)
      .filter((key) => !saved.has(key));
    if (newWorkspaces.length === 0) continue;
    workspaceOrderByProject[project.viewKey] = newWorkspaces;
    childOrder[sidebarFolderContainerKey({ kind: "project", projectKey: project.viewKey }, null)] =
      newWorkspaces;
  }
  if (Object.keys(workspaceOrderByProject).length > 0)
    placement.workspaceOrderByProject = workspaceOrderByProject;
  if (Object.keys(childOrder).length === 0) return null;
  placement.childOrder = childOrder;
  return placement;
}

/**
 * The patch that records a placement. A Host that advertises `sidebarPlacement` applies it to
 * its own current order, so concurrent devices cannot overwrite each other. Older Hosts drop
 * `placeFirst`, so they get whole-list replacements built from this device's order instead.
 */
export function sidebarPlacementPatch(input: {
  placement: SidebarPlaceFirst;
  supported: boolean;
  projectOrder: readonly string[];
  workspaceOrderByProject: Readonly<Record<string, readonly string[]>>;
  childOrder: Readonly<Record<string, readonly string[]>>;
}): SidebarStatePatch {
  if (input.supported) return { placeFirst: input.placement };
  const patch: SidebarStatePatch = {};
  if (input.placement.projectOrder)
    patch.projectOrder = placeKeysFirst(input.projectOrder, input.placement.projectOrder);
  if (input.placement.workspaceOrderByProject) {
    patch.workspaceOrderByProject = {};
    for (const [projectKey, keys] of Object.entries(input.placement.workspaceOrderByProject))
      patch.workspaceOrderByProject[projectKey] = placeKeysFirst(
        input.workspaceOrderByProject[projectKey] ?? [],
        keys,
      );
  }
  if (input.placement.childOrder) {
    const childOrder: Record<string, string[]> = {};
    for (const [container, keys] of Object.entries(input.placement.childOrder)) {
      const saved = input.childOrder[container];
      if (saved) childOrder[container] = placeKeysFirst(saved, keys);
    }
    if (Object.keys(childOrder).length > 0) patch.childOrder = childOrder;
  }
  return patch;
}
