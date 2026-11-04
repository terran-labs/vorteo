import type { SidebarStateBucket } from "@/hooks/sidebar-workspaces-view-model";
import type { SidebarTreeRow } from "@/sidebar-folders/tree";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { SidebarGroupItem } from "./sidebar-group-visibility";

/**
 * Rows a project's folder tree shows before Show more. Vorteo keeps more than Paseo's seven-row
 * workspace limit; folder rows count toward it like workspace rows.
 */
export const SIDEBAR_TREE_VISIBLE_ROWS = 20;

export interface SidebarTreeGroupVisibilityInput<T> {
  rows: readonly SidebarTreeRow<T>[];
  expanded: boolean;
  getStatusBucket: (item: T) => SidebarStateBucket;
  /** The workspace the rows highlight as selected. Null when no row can be selected. */
  selection: ActiveWorkspaceSelection | null;
}

export interface SidebarTreeGroupVisibility<T> {
  /**
   * The open workspace when the limit would hide it. Rendered before `visibleRows`, out of tree
   * order and outside the drag list. Never also present in `visibleRows`.
   */
  leadingItem: T | null;
  visibleRows: SidebarTreeRow<T>[];
  canToggle: boolean;
}

function isOpenWorkspace(item: SidebarGroupItem, selection: ActiveWorkspaceSelection | null) {
  return (
    selection !== null &&
    item.serverId === selection.serverId &&
    item.workspaceId === selection.workspaceId
  );
}

/**
 * Paseo's collapsed-group rules applied to a flattened folder tree: rows past the limit stay
 * visible while their workspace is not Done, together with the folders that contain them, and a
 * hidden open workspace leads the group instead of waiting behind Show more.
 */
export function selectSidebarTreeGroupVisibility<T extends SidebarGroupItem>(
  input: SidebarTreeGroupVisibilityInput<T>,
): SidebarTreeGroupVisibility<T> {
  const { rows, expanded, getStatusBucket, selection } = input;
  const shown = new Set<number>();
  let leadingIndex = -1;

  rows.forEach((row, index) => {
    if (index < SIDEBAR_TREE_VISIBLE_ROWS) {
      shown.add(index);
      return;
    }
    if (row.kind !== "item") return;
    if (getStatusBucket(row.item) !== "done") {
      shown.add(index);
      // Keep the folders above an active row so it does not appear under the wrong parent.
      let depth = row.depth;
      for (let parent = index - 1; parent >= 0 && depth > 0; parent -= 1) {
        const candidate = rows[parent]!;
        if (candidate.kind === "folder" && candidate.depth < depth) {
          shown.add(parent);
          depth = candidate.depth;
        }
      }
    } else if (leadingIndex === -1 && isOpenWorkspace(row.item, selection)) {
      leadingIndex = index;
    }
  });

  const canToggle = rows.some((_, index) => !shown.has(index) && index !== leadingIndex);
  if (expanded || !canToggle) {
    return { leadingItem: null, visibleRows: rows.slice(), canToggle };
  }
  const leadingRow = leadingIndex === -1 ? null : rows[leadingIndex]!;
  return {
    leadingItem: leadingRow?.kind === "item" ? leadingRow.item : null,
    visibleRows: rows.filter((_, index) => shown.has(index)),
    canToggle,
  };
}
