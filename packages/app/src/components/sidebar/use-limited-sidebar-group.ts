import { useCallback, useMemo, useState } from "react";
import {
  selectSidebarGroupVisibility,
  type SidebarGroupItem,
  type SidebarGroupVisibility,
  type SidebarGroupVisibilityPolicy,
} from "./sidebar-group-visibility";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import { selectLimitedTreeRows, type SidebarTreeRow } from "@/sidebar-folders/tree";

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

const INITIAL_VISIBLE_ITEMS = 20;

export function useLimitedSidebarTreeGroup<T>(items: readonly T[]) {
  const [expanded, setExpanded] = useState(false);
  const visibleItems = useMemo(
    () => (expanded ? items.slice() : items.slice(0, INITIAL_VISIBLE_ITEMS)),
    [expanded, items],
  );
  const canToggle = items.length > INITIAL_VISIBLE_ITEMS;
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return { visibleItems, expanded, canToggle, toggleExpanded };
}

/**
 * A project's folder tree shows 20 rows until expanded, keeping active workspaces in place and
 * leading with the open workspace when the limit would hide it (owner decision, 2026-11-07).
 */
export function useLimitedSidebarTreeRows<T>(
  rows: readonly SidebarTreeRow<T>[],
  policy: { isActive: (item: T) => boolean; isOpen: (item: T) => boolean },
) {
  const [expanded, setExpanded] = useState(false);
  const { isActive, isOpen } = policy;
  const limited = useMemo(
    () => selectLimitedTreeRows({ rows, expanded, limit: INITIAL_VISIBLE_ITEMS, isActive, isOpen }),
    [expanded, rows, isActive, isOpen],
  );
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);

  return {
    visibleItems: limited.visibleRows,
    leadingItem: limited.leadingItem,
    expanded,
    canToggle: limited.canToggle,
    toggleExpanded,
  };
}
