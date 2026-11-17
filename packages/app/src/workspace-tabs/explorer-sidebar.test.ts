import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { usePanelStore } from "@/stores/panel-store";
import { registerInlineDetailTiles } from "./supporting-card-requests";
import {
  collectAllTabs,
  findPaneById,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  isExplorerSidebarOpen,
  openExplorerSidebarView,
  resolveExplorerSidebarPresentation,
  toggleExplorerSidebar,
} from "@/workspace-tabs/explorer-sidebar";

const WORKSPACE_KEY = "server-1:ws-main";
const checkout = { serverId: "server-1", cwd: "/repo", isGit: true };

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    sheetsByWorkspace: {},
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
    explorerTabByCheckout: {},
    explorerTab: "files",
  });
});

describe("Explorer sidebar", () => {
  it("selects the Explorer shell from the form factor", () => {
    expect(resolveExplorerSidebarPresentation({ isCompact: true })).toBe("overlay");
    expect(
      resolveExplorerSidebarPresentation({ isCompact: false, supportsPaneSplits: false }),
    ).toBe("dock");
    expect(resolveExplorerSidebarPresentation({ isCompact: false, supportsPaneSplits: true })).toBe(
      "pane",
    );
  });

  it("opens workspace Changes in place on phones", () => {
    const releaseInlineTiles = registerInlineDetailTiles(WORKSPACE_KEY);
    openExplorerSidebarView({
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      checkout,
      view: "changes",
    });
    useWorkspaceLayoutStore.getState().setLayoutMode("compact");
    openExplorerSidebarView({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      checkout,
      view: "changes",
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
    expect(usePanelStore.getState().inlineCardExpanded.changes).toBe(true);
    expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[WORKSPACE_KEY] ?? []).toEqual([]);
    const input = { isCompact: true, workspaceKey: WORKSPACE_KEY, checkout };
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(false);
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(true);

    // Without a visible conversation, such as from a terminal, phones fall back to a sheet.
    releaseInlineTiles();
    openExplorerSidebarView({ ...input, view: "files" });
    expect(
      useWorkspaceLayoutStore
        .getState()
        .sheetsByWorkspace[WORKSPACE_KEY]?.map(({ tab }) => tab.target.kind),
    ).toEqual(["files"]);
    expect(isExplorerSidebarOpen(input)).toBe(true);
    toggleExplorerSidebar(input);
    expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[WORKSPACE_KEY] ?? []).toEqual([]);
    expect(usePanelStore.getState().inlineCardExpanded.files).toBe(true);
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });

  it("creates a dedicated desktop Explorer containing only its requested tree", () => {
    openExplorerSidebarView({
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      checkout,
      view: "files",
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const paneId = selectExplorerSidebarPaneId(state, WORKSPACE_KEY);
    expect(paneId).not.toBeNull();
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target.kind)).toContain("files");
  });

  it("toggles the desktop Explorer independently of ordinary panes", () => {
    const input = {
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      checkout,
    };
    openExplorerSidebarView({ ...input, view: "files" });
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(false);
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(true);
    const openedState = useWorkspaceLayoutStore.getState();
    const openedLayout = openedState.layoutByWorkspace[WORKSPACE_KEY];
    const explorerPaneId = selectExplorerSidebarPaneId(openedState, WORKSPACE_KEY);
    const explorerPane =
      openedLayout && explorerPaneId ? findPaneById(openedLayout.root, explorerPaneId) : null;
    const activeExplorerTarget =
      openedLayout && explorerPane
        ? collectAllTabs(openedLayout.root).find((tab) => tab.tabId === explorerPane.focusedTabId)
            ?.target.kind
        : null;
    expect(activeExplorerTarget).toBe("files");
  });

  it("toggles the wide native Explorer without changing its selected view", () => {
    const input = {
      isCompact: false,
      supportsPaneSplits: false,
      workspaceKey: WORKSPACE_KEY,
      checkout,
    };

    usePanelStore.getState().setExplorerTabForCheckout({ ...checkout, tab: "files" });
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(true);
    expect(usePanelStore.getState().explorerTab).toBe("files");
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(false);
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(true);
    expect(usePanelStore.getState().explorerTab).toBe("files");
    expect(usePanelStore.getState().explorerTabByCheckout).toEqual({ "server-1::/repo": "files" });
  });
});
