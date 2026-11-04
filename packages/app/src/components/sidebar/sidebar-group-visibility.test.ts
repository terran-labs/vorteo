import { describe, expect, it } from "vitest";
import type { SidebarStateBucket } from "@/hooks/sidebar-workspaces-view-model";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import {
  selectSidebarGroupVisibility,
  type SidebarGroupItem,
  type SidebarGroupVisibilityPolicy,
} from "./sidebar-group-visibility";
import type { SidebarTreeRow } from "@/sidebar-folders/tree";
import {
  selectSidebarTreeGroupVisibility,
  SIDEBAR_TREE_VISIBLE_ROWS,
} from "./sidebar-tree-group-visibility";

interface Item extends SidebarGroupItem {
  id: number;
  statusBucket: SidebarStateBucket;
}

const serverId = "host-a";

function rows(statuses: readonly SidebarStateBucket[], rowServerId = serverId): Item[] {
  return statuses.map((statusBucket, index) => ({
    id: index + 1,
    serverId: rowServerId,
    workspaceId: `workspace-${index + 1}`,
    statusBucket,
  }));
}

const workspacePolicy: SidebarGroupVisibilityPolicy<Item> = {
  kind: "workspaces",
  getStatusBucket: (item) => item.statusBucket,
};

function selectionFor(item: SidebarGroupItem): ActiveWorkspaceSelection {
  return { serverId: item.serverId, workspaceId: item.workspaceId };
}

describe("selectSidebarGroupVisibility", () => {
  it("leads with a hidden open row while keeping the baseline order", () => {
    const items = rows(Array(9).fill("done"));
    const result = selectSidebarGroupVisibility({
      items,
      expanded: false,
      policy: workspacePolicy,
      selection: selectionFor(items[8]!),
    });

    expect(result.leadingItem).toBe(items[8]);
    expect(result.visibleItems).toEqual(items.slice(0, 7));
    expect(result.canToggle).toBe(true);
  });

  it("leaves selected rows in place when they are already in the baseline", () => {
    const items = rows([...Array(8).fill("done"), "running", "done"]);
    const expected = [...items.slice(0, 7), items[8]];

    for (const selectedIndex of [2, 8]) {
      const result = selectSidebarGroupVisibility({
        items,
        expanded: false,
        policy: workspacePolicy,
        selection: selectionFor(items[selectedIndex]!),
      });

      expect(result.leadingItem).toBeNull();
      expect(result.visibleItems).toEqual(expected);
      expect(result.canToggle).toBe(true);
    }
  });

  it("shows the whole group without a toggle when the open row is the only hidden row", () => {
    const items = rows(Array(8).fill("done"));
    const result = selectSidebarGroupVisibility({
      items,
      expanded: false,
      policy: workspacePolicy,
      selection: selectionFor(items[7]!),
    });

    expect(result.leadingItem).toBeNull();
    expect(result.visibleItems).toEqual(items);
    expect(result.canToggle).toBe(false);
  });

  it("keeps expanded groups in their original order", () => {
    const items = rows(Array(9).fill("done"));
    const result = selectSidebarGroupVisibility({
      items,
      expanded: true,
      policy: workspacePolicy,
      selection: selectionFor(items[8]!),
    });

    expect(result.leadingItem).toBeNull();
    expect(result.visibleItems).toEqual(items);
    expect(result.canToggle).toBe(true);
  });

  it("applies the twenty-row limit to pinned groups", () => {
    const items = rows(Array(22).fill("done"));
    const result = selectSidebarGroupVisibility({
      items,
      expanded: false,
      policy: { kind: "pinned" },
      selection: selectionFor(items[21]!),
    });

    expect(result.leadingItem).toBe(items[21]);
    expect(result.visibleItems).toEqual(items.slice(0, 20));
    expect(result.canToggle).toBe(true);
  });

  it("preserves the current limit when selection is null", () => {
    const items = rows(Array(8).fill("done"));
    const result = selectSidebarGroupVisibility({
      items,
      expanded: false,
      policy: workspacePolicy,
      selection: null,
    });

    expect(result.leadingItem).toBeNull();
    expect(result.visibleItems).toEqual(items.slice(0, 7));
    expect(result.canToggle).toBe(true);
  });

  it("matches the open row by server and workspace identity", () => {
    const items = rows(Array(9).fill("done"), "host-b");
    const result = selectSidebarGroupVisibility({
      items,
      expanded: false,
      policy: workspacePolicy,
      selection: { serverId: serverId, workspaceId: items[8]!.workspaceId },
    });

    expect(result.leadingItem).toBeNull();
    expect(result.visibleItems).toEqual(items.slice(0, 7));
    expect(result.canToggle).toBe(true);
  });
});

describe("selectSidebarTreeGroupVisibility", () => {
  function itemRows(items: readonly Item[], depth = 0): SidebarTreeRow<Item>[] {
    return items.map((item) => ({
      kind: "item",
      key: item.workspaceId,
      item,
      depth,
      folderId: depth === 0 ? null : "folder-1",
    }));
  }

  const folderRow: SidebarTreeRow<Item> = {
    kind: "folder",
    key: "folder:folder-1",
    folder: {
      id: "folder-1",
      name: "Later",
      parentId: null,
      scope: { kind: "project", projectKey: "project-a" },
      createdAt: "2026-11-03T00:00:00.000Z",
    },
    depth: 0,
    collapsed: false,
    itemCount: 2,
  };

  it("keeps active rows with their folder and leads with the hidden open workspace", () => {
    const top = rows(Array(SIDEBAR_TREE_VISIBLE_ROWS + 1).fill("done"));
    const nestedDone: Item = { id: 101, serverId, workspaceId: "nested-1", statusBucket: "done" };
    const nestedRunning: Item = {
      id: 102,
      serverId,
      workspaceId: "nested-2",
      statusBucket: "running",
    };
    const treeRows = [...itemRows(top), folderRow, ...itemRows([nestedDone!, nestedRunning!], 1)];
    const result = selectSidebarTreeGroupVisibility({
      rows: treeRows,
      expanded: false,
      getStatusBucket: (item) => item.statusBucket,
      selection: selectionFor(top[SIDEBAR_TREE_VISIBLE_ROWS]!),
    });

    expect(result.leadingItem).toBe(top[SIDEBAR_TREE_VISIBLE_ROWS]);
    expect(result.visibleRows).toEqual([
      ...treeRows.slice(0, SIDEBAR_TREE_VISIBLE_ROWS),
      folderRow,
      treeRows[treeRows.length - 1],
    ]);
    expect(result.canToggle).toBe(true);
  });

  it("shows every row in order without a toggle when the open row is the only hidden row", () => {
    const items = rows(Array(SIDEBAR_TREE_VISIBLE_ROWS + 1).fill("done"));
    const treeRows = itemRows(items);
    const result = selectSidebarTreeGroupVisibility({
      rows: treeRows,
      expanded: false,
      getStatusBucket: (item) => item.statusBucket,
      selection: selectionFor(items[SIDEBAR_TREE_VISIBLE_ROWS]!),
    });

    expect(result).toEqual({ leadingItem: null, visibleRows: treeRows, canToggle: false });
  });
});
