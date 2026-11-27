import { useCallback, type ReactNode } from "react";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { SidebarSectionRow } from "./container-row";
import { SidebarDisclosureBody } from "./disclosure-body";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";

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
  defaultCollapsed = false,
  menu,
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
  /** Starts folded; the stored key then records that the owner opened it. */
  defaultCollapsed?: boolean;
  /** Menu items the row offers on right-click or long press. */
  menu?: ReactNode;
  testID: string;
  children: ReactNode;
}) {
  const toggled = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedWorkspaceGroupKeys.has(groupKey),
  );
  const collapsed = defaultCollapsed ? !toggled : toggled;
  const toggleGroupCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleWorkspaceGroupCollapsed,
  );
  const toggle = useCallback(
    () => toggleGroupCollapsed(groupKey),
    [toggleGroupCollapsed, groupKey],
  );
  const row = (
    <SidebarSectionRow
      title={title}
      count={count}
      collapsed={collapsed}
      onToggle={toggle}
      level={level}
      testID={testID}
    />
  );
  return (
    <>
      {menu ? (
        <ContextMenu>
          <ContextMenuTrigger contextOnly testID={`${testID}-menu-trigger`}>
            {row}
          </ContextMenuTrigger>
          <ContextMenuContent align="start" width={260} testID={`${testID}-menu`}>
            {menu}
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}
      <SidebarDisclosureBody expanded={!collapsed}>{children}</SidebarDisclosureBody>
    </>
  );
}
