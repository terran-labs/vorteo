import { useCallback, useMemo, useState } from "react";
import {
  selectSidebarGroupVisibility,
  type SidebarGroupItem,
  type SidebarGroupVisibility,
  type SidebarGroupVisibilityPolicy,
} from "./sidebar-group-visibility";
import {
  selectSidebarTreeGroupVisibility,
  SIDEBAR_TREE_VISIBLE_ROWS,
  type SidebarTreeGroupVisibility,
} from "./sidebar-tree-group-visibility";
import type { SidebarStateBucket } from "@/hooks/sidebar-workspaces-view-model";
import type { SidebarTreeRow } from "@/sidebar-folders/tree";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

const PINNED_POLICY = { kind: "pinned" } as const;

interface LimitedSidebarGroupInput<T> {
  items: readonly T[];
  selection: ActiveWorkspaceSelection | null;
  policy?: SidebarGroupVisibilityPolicy<T>;
}

export function useLimitedSidebarGroup<T extends SidebarGroupItem>({
  items,
  selection,
  policy = PINNED_POLICY,
}: LimitedSidebarGroupInput<T>): SidebarGroupVisibility<T> & {
  expanded: boolean;
  toggleExpanded: () => void;
} {
  const [expanded, setExpanded] = useState(false);
  const visibility = useMemo(
    () => selectSidebarGroupVisibility({ items, expanded, policy, selection }),
    [expanded, items, policy, selection],
  );
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { ...visibility, expanded, toggleExpanded };
}

export function useLimitedSidebarTreeGroup<T>(items: readonly T[]) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = useMemo(
    () => (expanded ? items.slice() : items.slice(0, SIDEBAR_TREE_VISIBLE_ROWS)),
    [expanded, items],
  );
  const canToggle = items.length > SIDEBAR_TREE_VISIBLE_ROWS;
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { visibleItems, expanded, canToggle, toggleExpanded };
}

/** A project's workspace tree, which keeps active rows and the open workspace past the limit. */
export function useLimitedSidebarWorkspaceTree<T extends SidebarGroupItem>({
  rows,
  selection,
  getStatusBucket,
}: {
  rows: readonly SidebarTreeRow<T>[];
  selection: ActiveWorkspaceSelection | null;
  getStatusBucket: (item: T) => SidebarStateBucket;
}): SidebarTreeGroupVisibility<T> & { expanded: boolean; toggleExpanded: () => void } {
  const [expanded, setExpanded] = useState(false);
  const visibility = useMemo(
    () => selectSidebarTreeGroupVisibility({ rows, expanded, getStatusBucket, selection }),
    [expanded, getStatusBucket, rows, selection],
  );
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { ...visibility, expanded, toggleExpanded };
}
