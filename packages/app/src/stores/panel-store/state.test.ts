import { describe, expect, it } from "vitest";
import {
  DEFAULT_TREE_RAIL_WIDTH,
  cycleDesktopSidebar,
  resolveResponsiveSidebar,
  migratePanelState,
  selectIsAgentListOpen,
  selectIsCompactFileExplorerOpen,
  setMobilePanelTarget,
  type PanelCoreState,
} from "./state";

function makePanelState(overrides: Partial<PanelCoreState> = {}): PanelCoreState {
  return {
    explorerTab: "changes",
    explorerTabByCheckout: {},
    mobilePanel: { target: "agent", revision: 0 },
    desktop: {
      agentListOpen: false,
    },
    ...overrides,
  };
}

describe("panel-store migration", () => {
  it("defaults hidden-file visibility to showing hidden files", () => {
    const state = migratePanelState({}, 10);

    expect(state.explorerShowHiddenFiles).toBe(true);
  });

  it("initializes diffCollapsedFoldersByWorkspace for pre-v12 state", () => {
    const state = migratePanelState({}, 11);

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({});
  });

  it("preserves an existing diffCollapsedFoldersByWorkspace map", () => {
    const state = migratePanelState({ diffCollapsedFoldersByWorkspace: { ws: ["src/app"] } }, 12);

    expect(state.diffCollapsedFoldersByWorkspace).toEqual({ ws: ["src/app"] });
  });

  it("initializes and preserves collapsed diff file paths by workspace", () => {
    expect(migratePanelState({}, 14).collapsedFilePathsByWorkspace).toEqual({});
    expect(
      migratePanelState({ collapsedFilePathsByWorkspace: { ws: ["src/app.ts"] } }, 14)
        .collapsedFilePathsByWorkspace,
    ).toEqual({ ws: ["src/app.ts"] });
  });

  it("drops the retired per-file diff expansion state", () => {
    const state = migratePanelState({ diffExpandedPathsByWorkspace: { ws: ["src/app.ts"] } }, 13);

    expect(state.diffExpandedPathsByWorkspace).toBeUndefined();
  });

  it("replaces the dead explorer split ratio with the shared tree rail width", () => {
    const state = migratePanelState({ explorerFilesSplitRatio: 0.5 }, 12);

    expect(state.explorerFilesSplitRatio).toBeUndefined();
    expect(state.treeRailWidth).toBe(DEFAULT_TREE_RAIL_WIDTH);
  });

  it("narrows an existing install's tree rail to the new default width", () => {
    expect(DEFAULT_TREE_RAIL_WIDTH).toBeLessThan(320);
    expect(migratePanelState({ treeRailWidth: 320 }, 15).treeRailWidth).toBe(
      DEFAULT_TREE_RAIL_WIDTH,
    );
  });

  it("defaults the file panel tree to open and keeps it closed once closed", () => {
    expect(migratePanelState({}, 15).fileTreeVisible).toBe(true);
    expect(migratePanelState({ fileTreeVisible: false }, 16).fileTreeVisible).toBe(false);
  });

  it("drops persisted compact panel state so cold starts return to content", () => {
    const state = migratePanelState(
      { mobileView: "agent-list", mobilePanel: { target: "file-explorer", revision: 42 } },
      11,
    );

    expect(state.mobileView).toBeUndefined();
    expect(state.mobilePanel).toBeUndefined();
  });
});

describe("panel-store visibility selectors", () => {
  it("increments the mobile panel revision only when the target changes", () => {
    const initial = { target: "agent" as const, revision: 4 };

    expect(setMobilePanelTarget(initial, "agent")).toBe(initial);
    expect(setMobilePanelTarget(initial, "agent-list")).toEqual({
      target: "agent-list",
      revision: 5,
    });
  });

  it("uses the mobile panel target for compact layout visibility", () => {
    const state = makePanelState({
      mobilePanel: { target: "file-explorer", revision: 1 },
      desktop: { agentListOpen: true },
    });

    expect(selectIsAgentListOpen(state, { isCompact: true })).toBe(false);
    expect(selectIsCompactFileExplorerOpen(state)).toBe(true);
  });

  it("uses the desktop flag for the expanded agent list", () => {
    const state = makePanelState({
      mobilePanel: { target: "file-explorer", revision: 1 },
      desktop: { agentListOpen: true },
    });

    expect(selectIsAgentListOpen(state, { isCompact: false })).toBe(true);
  });
});

it("preserves checkout tab selection and other panel preferences", () => {
  const state = migratePanelState(
    { explorerTab: "files", explorerTabByCheckout: { checkout: "changes" }, sidebarWidth: 400 },
    16,
  );
  expect(state.explorerTab).toBe("files");
  expect(state.explorerTabByCheckout).toEqual({ checkout: "changes" });
  expect(state.sidebarWidth).toBe(400);
});

describe("persistent desktop rail migration", () => {
  it("restores a previously hidden sidebar as the minimal rail without changing its saved width", () => {
    const migrated = migratePanelState(
      { desktop: { agentListOpen: false }, sidebarWidth: 412 },
      16,
    );
    expect(migrated.desktop?.agentListOpen).toBe(true);
    expect(migrated.sidebarCompact).toBe(true);
    expect(migrated.sidebarWidth).toBe(412);
  });
});

describe("responsive sidebar presentation", () => {
  const expanded = { sidebarCompact: false, sidebarNarrow: false, sidebarWidth: 360 };
  it("toggles directly between normal and rail, including old intermediate preferences", () => {
    const rail = cycleDesktopSidebar(expanded);
    expect(rail).toEqual({ sidebarCompact: true, sidebarNarrow: false });
    expect(cycleDesktopSidebar(rail)).toEqual({ sidebarCompact: false, sidebarNarrow: false });
    expect(cycleDesktopSidebar({ sidebarCompact: false, sidebarNarrow: true })).toEqual(rail);
  });
  it("uses the rail only while the saved width would crowd the center", () => {
    expect(resolveResponsiveSidebar(expanded, 1300).sidebarCompact).toBe(false);
    expect(resolveResponsiveSidebar(expanded, 800).sidebarCompact).toBe(true);
    expect(resolveResponsiveSidebar(expanded, 1300).sidebarCompact).toBe(false);
    expect(expanded.sidebarWidth).toBe(360);
  });
  it("keeps manual modes and expires a manual expansion at a different viewport width", () => {
    expect(
      resolveResponsiveSidebar({ ...expanded, sidebarCompact: true }, 1800).sidebarCompact,
    ).toBe(true);
    expect(resolveResponsiveSidebar({ ...expanded, sidebarNarrow: true }, 1000).sidebarNarrow).toBe(
      false,
    );
    expect(
      resolveResponsiveSidebar({ ...expanded, sidebarViewportOverride: 800 }, 800).sidebarCompact,
    ).toBe(false);
    expect(
      resolveResponsiveSidebar({ ...expanded, sidebarViewportOverride: 800 }, 790).sidebarCompact,
    ).toBe(true);
  });
});

describe("device-local card preferences", () => {
  it("seeds inline choices once without coupling later layout preferences", () => {
    const upgraded = migratePanelState({ supportingCardExpanded: { tasks: false } }, 18);
    expect(upgraded.inlineCardExpanded).toEqual({ tasks: false });
    expect(upgraded.inlineCardExpanded).not.toBe(upgraded.supportingCardExpanded);
    const restored = migratePanelState({ ...upgraded, inlineCardExpanded: { tasks: true } }, 19);
    expect(restored.supportingCardExpanded).toEqual({ tasks: false });
    expect(restored.inlineCardExpanded).toEqual({ tasks: true });
  });
  it("preserves independent disclosure choices while migrating existing panel settings", () => {
    const state = migratePanelState(
      {
        sidebarWidth: 360,
        supportingCardExpanded: { tasks: false, journal: true, files: false, changes: true },
      },
      17,
    );
    expect(state.sidebarWidth).toBe(360);
    expect(state.supportingCardExpanded).toEqual({
      tasks: false,
      journal: true,
      files: false,
      changes: true,
    });
  });
  it("keeps older panel preferences when no card choices have been saved", () => {
    const state = migratePanelState({ sidebarWidth: 360, sidebarCompact: true }, 17);
    expect(state.sidebarWidth).toBe(360);
    expect(state.sidebarCompact).toBe(true);
    expect(state.supportingCardExpanded).toBeUndefined();
  });
});

describe("retired focus mode preferences", () => {
  it.each(["focusModeEnabled", "zoomed", "focused"])(
    "discards %s without losing panel preferences",
    (key) => {
      const state = migratePanelState(
        {
          desktop: { agentListOpen: true, [key]: true },
          sidebarWidth: 412,
          sidebarCompact: false,
          supportingCardExpanded: { tasks: false },
          inlineCardExpanded: { journal: false },
        },
        19,
      );
      expect(state.desktop).toEqual({ agentListOpen: true });
      expect(state.sidebarWidth).toBe(412);
      expect(state.sidebarCompact).toBe(false);
      expect(state.supportingCardExpanded).toEqual({ tasks: false });
      expect(state.inlineCardExpanded).toEqual({ journal: false });
    },
  );
});
