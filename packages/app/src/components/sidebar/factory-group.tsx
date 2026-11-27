import { useCallback, type ReactNode } from "react";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { SidebarSectionRow } from "./container-row";
import { SidebarDisclosureBody } from "./disclosure-body";

/**
 * A group inside a Factory section, such as Crew or Runners. It folds like every other
 * hierarchical sidebar level: the shared section row, its disclosure body, and the remembered
 * collapse state of workspace groups, keyed per Factory card.
 */
export function FactoryGroup({
  groupKey,
  title,
  count,
  level,
  testID,
  children,
}: {
  /** Collapse key in the sidebar's synced group state, such as `factory-runners:<card>`. */
  groupKey: string;
  title: string;
  /** Shown while folded. */
  count: number;
  /** The group row's level; its items sit one further in. */
  level: number;
  testID: string;
  children: ReactNode;
}) {
  const collapsed = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedWorkspaceGroupKeys.has(groupKey),
  );
  const toggleGroupCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleWorkspaceGroupCollapsed,
  );
  const toggle = useCallback(
    () => toggleGroupCollapsed(groupKey),
    [toggleGroupCollapsed, groupKey],
  );
  return (
    <>
      <SidebarSectionRow
        title={title}
        count={count}
        collapsed={collapsed}
        onToggle={toggle}
        level={level}
        testID={testID}
      />
      <SidebarDisclosureBody expanded={!collapsed}>{children}</SidebarDisclosureBody>
    </>
  );
}
