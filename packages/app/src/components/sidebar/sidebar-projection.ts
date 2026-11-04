import { splitFactoryWorkspaces } from "@/workspace/lifecycle/grouping";
import type { TFunction } from "i18next";
import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { EMPTY_SIDEBAR_FOLDER_STATE, type SidebarFolderState } from "@/sidebar-folders/store";
import {
  ROOT_FOLDER_SCOPE,
  buildSidebarTreeRows,
  type SidebarTreeItemOrder,
  projectFolderScope,
  type SidebarTreeRow,
} from "@/sidebar-folders/tree";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  workspaceGroups: SidebarWorkspaceGroup[];
  /**
   * The project icons this projection needs fetched, keyed by `projectViewKey` — one per project,
   * whatever the mode groups by. It sits here rather than beside `useProjectIcons` in the list
   * because it is the same `projects` the rows above are projected from: a mode that renders a
   * row can only ever ask for an icon this list already covers. It used to be derived in the
   * list, under a `groupMode === "status"` gate written when status was the only mode that put
   * icons on rows.
   */
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  t: TFunction;
  factorySupportedHosts?: ReadonlyMap<string, boolean>;
  /** Null when the sidebar host cannot store folders. */
  folderState?: SidebarFolderState | null;
  /** `given` when a time-based workspace sort decides item order inside folders. */
  workspaceItemOrder?: SidebarTreeItemOrder;
}

function visibleTreeItems<T>(rows: readonly SidebarTreeRow<T>[]): T[] {
  return rows.flatMap((row) => (row.kind === "item" ? [row.item] : []));
}

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  // Pinned workspaces stay in their status groups too, as they stay in their projects.
  const workspaces = Array.from(input.workspaceEntriesByKey.values());
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  const workspaceGroups = buildWorkspaceGroups(input, workspaces);

  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  if (input.groupMode === "project") {
    // Shortcuts follow the rows on screen, so they skip anything inside a collapsed folder.
    const folderState = input.folderState ?? EMPTY_SIDEBAR_FOLDER_STATE;
    const projects = visibleTreeItems(
      buildSidebarTreeRows({
        state: folderState,
        scope: ROOT_FOLDER_SCOPE,
        items: pinnedGroups.projects,
        getKey: (project) => project.viewKey,
        hideEmptyFolders: false,
      }),
    );
    sections.push(
      ...projects.flatMap((project) => {
        const collapsed = input.collapsedProjectKeys.has(project.viewKey);
        const groups = splitFactoryWorkspaces(
          project.workspaces,
          input.workspaceEntriesByKey,
          input.factorySupportedHosts ?? new Map(),
        );
        const work = visibleTreeItems(
          buildSidebarTreeRows({
            state: folderState,
            scope: projectFolderScope(project.viewKey),
            items: groups.work,
            getKey: (workspace) => workspace.workspaceKey,
            hideEmptyFolders: false,
            itemOrder: input.workspaceItemOrder ?? "saved",
          }),
        );
        const standingCollapsed =
          collapsed || input.collapsedWorkspaceGroupKeys.has(`standing:${project.viewKey}`);
        return [
          { workspaces: work, collapsed },
          {
            workspaces: groups.factory,
            collapsed:
              collapsed || input.collapsedWorkspaceGroupKeys.has(`factory:${project.viewKey}`),
          },
          { workspaces: groups.standing, collapsed: standingCollapsed },
        ];
      }),
    );
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }

  return {
    pinnedGroups,
    workspaceGroups,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

/** Project mode keeps its project headers and groups nothing; status mode groups the rows. */
function buildWorkspaceGroups(
  input: SidebarProjectionInput,
  workspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  switch (input.groupMode) {
    case "project":
      return [];
    case "status":
      return statusWorkspaceGroups(
        buildStatusGroups(workspaces, input.projectNamesByViewKey, input.t),
      );
  }
}
