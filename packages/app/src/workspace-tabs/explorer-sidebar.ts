import { useSessionStore } from "@/stores/session-store";
import { supportsDesktopPaneSplits } from "@/constants/layout";
import { selectIsCompactFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import type { ExplorerCheckoutContext } from "@/stores/explorer-checkout-context";
import {
  selectIsExplorerSidebarVisible,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { hasInlineDetailTiles, requestSupportingCard } from "./supporting-card-requests";

export type ExplorerSidebarView = "changes" | "files" | "pr";
export type ExplorerSidebarPresentation = "overlay" | "dock" | "pane";

const VIEW_TARGETS: Record<ExplorerSidebarView, WorkspaceTabTarget> = {
  changes: { kind: "changes_tree" },
  files: { kind: "files" },
  pr: { kind: "pull_request" },
};

export interface ExplorerSidebarQuery {
  isCompact: boolean;
  workspaceKey: string | null;
  supportsPaneSplits?: boolean;
}

export interface ExplorerSidebarInput extends ExplorerSidebarQuery {
  checkout?: ExplorerCheckoutContext | null;
}

export function resolveExplorerSidebarPresentation(
  input: Pick<ExplorerSidebarQuery, "isCompact" | "supportsPaneSplits">,
): ExplorerSidebarPresentation {
  if (input.isCompact) {
    return "overlay";
  }
  return (input.supportsPaneSplits ?? supportsDesktopPaneSplits()) ? "pane" : "dock";
}

export function usesCompactExplorerSidebar(
  input: Pick<ExplorerSidebarQuery, "isCompact" | "supportsPaneSplits">,
): boolean {
  return resolveExplorerSidebarPresentation(input) !== "pane";
}

function canUseExplorerSidebar(
  input: Pick<ExplorerSidebarQuery, "isCompact" | "supportsPaneSplits">,
): boolean {
  return resolveExplorerSidebarPresentation(input) === "pane";
}

/**
 * Phones expand the detail tile in the visible conversation. Where none is shown, such as from a
 * terminal or draft, the view opens in a sheet as before.
 */
export function revealCompactDetail(workspaceKey: string, target: WorkspaceTabTarget): void {
  if (hasInlineDetailTiles(workspaceKey)) {
    requestSupportingCard(workspaceKey, target.kind, "inline");
    return;
  }
  useWorkspaceLayoutStore.getState().openTab({ workspaceKey, target, intent: "reveal" });
}

/** Reveals the Explorer sidebar and selects one of its navigation trees. */
export function openExplorerSidebarView(
  input: ExplorerSidebarInput & { view: ExplorerSidebarView },
): void {
  if (input.isCompact && input.workspaceKey) {
    revealCompactDetail(input.workspaceKey, VIEW_TARGETS[input.view]);
    return;
  }
  if (usesCompactExplorerSidebar(input)) {
    const checkout = resolveCheckout(input);
    if (!checkout) return;
    const panel = usePanelStore.getState();
    panel.setExplorerTabForCheckout({ ...checkout, tab: input.view });
    panel.openCompactFileExplorer(checkout);
    return;
  }
  if (!input.workspaceKey) return;
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.showExplorerSidebar(input.workspaceKey);
  requestSupportingCard(input.workspaceKey, VIEW_TARGETS[input.view].kind);
  store.openTab({
    workspaceKey: input.workspaceKey,
    target: VIEW_TARGETS[input.view],
    intent: "reveal",
    placement: paneId ? { mode: "pane", paneId } : undefined,
  });
}

export function showExplorerSidebar(input: ExplorerSidebarInput): void {
  if (input.isCompact && input.workspaceKey) {
    openExplorerSidebarView({ ...input, view: "files" });
    return;
  }
  if (usesCompactExplorerSidebar(input)) {
    const checkout = resolveCheckout(input);
    if (checkout) usePanelStore.getState().openCompactFileExplorer(checkout);
    return;
  }
  if (input.workspaceKey && canUseExplorerSidebar(input)) {
    useWorkspaceLayoutStore.getState().showExplorerSidebar(input.workspaceKey);
  }
}

export function hideExplorerSidebar(input: ExplorerSidebarInput): void {
  if (input.isCompact && input.workspaceKey) {
    if (!hasInlineDetailTiles(input.workspaceKey)) {
      // The fallback for callers outside a conversation is a sheet; close that instead.
      const store = useWorkspaceLayoutStore.getState();
      const tabId = explorerSheetId(store, input.workspaceKey);
      if (tabId) store.closeTab(input.workspaceKey, tabId);
      return;
    }
    const panel = usePanelStore.getState();
    panel.setSupportingCardExpanded("files", false, "inline");
    panel.setSupportingCardExpanded("changes", false, "inline");
    return;
  }
  if (usesCompactExplorerSidebar(input)) {
    usePanelStore.getState().showMobileAgent();
    return;
  }
  if (input.workspaceKey && canUseExplorerSidebar(input)) {
    useWorkspaceLayoutStore.getState().hideExplorerSidebar(input.workspaceKey);
  }
}

export function toggleExplorerSidebar(input: ExplorerSidebarInput): void {
  if (input.isCompact && input.workspaceKey) {
    if (isExplorerSidebarOpen(input)) hideExplorerSidebar(input);
    else showExplorerSidebar(input);
    return;
  }
  if (usesCompactExplorerSidebar(input)) {
    const checkout = resolveCheckout(input);
    if (checkout) usePanelStore.getState().toggleCompactFileExplorer(checkout);
    return;
  }
  if (!input.workspaceKey) return;
  if (isExplorerSidebarOpen(input)) {
    hideExplorerSidebar(input);
  } else {
    showExplorerSidebar(input);
  }
}

export function useIsExplorerSidebarOpen(input: ExplorerSidebarQuery): boolean {
  const compactOpen = usePanelStore(selectIsCompactFileExplorerOpen);
  const inlineOpen = usePanelStore((state) =>
    Boolean(state.inlineCardExpanded.files || state.inlineCardExpanded.changes),
  );
  const workspaceOpen = useWorkspaceLayoutStore((state) => {
    if (!input.workspaceKey) return false;
    if (input.isCompact) return false;
    return (
      canUseExplorerSidebar(input) && selectIsExplorerSidebarVisible(state, input.workspaceKey)
    );
  });
  if (input.isCompact && input.workspaceKey) return inlineOpen;
  return usesCompactExplorerSidebar(input) ? compactOpen : workspaceOpen;
}

export function isExplorerSidebarOpen(input: ExplorerSidebarQuery): boolean {
  if (input.isCompact && input.workspaceKey) {
    if (!hasInlineDetailTiles(input.workspaceKey)) {
      return explorerSheetId(useWorkspaceLayoutStore.getState(), input.workspaceKey) !== null;
    }
    const { inlineCardExpanded } = usePanelStore.getState();
    return Boolean(inlineCardExpanded.files || inlineCardExpanded.changes);
  }
  if (usesCompactExplorerSidebar(input)) {
    return selectIsCompactFileExplorerOpen(usePanelStore.getState());
  }
  return Boolean(
    input.workspaceKey &&
    canUseExplorerSidebar(input) &&
    selectIsExplorerSidebarVisible(useWorkspaceLayoutStore.getState(), input.workspaceKey),
  );
}

function explorerSheetId(
  state: ReturnType<typeof useWorkspaceLayoutStore.getState>,
  workspaceKey: string,
): string | null {
  const sheet = state.sheetsByWorkspace[workspaceKey]?.findLast(({ tab }) =>
    ["files", "changes_tree", "pull_request"].includes(tab.target.kind),
  );
  return sheet?.tab.tabId ?? null;
}

/** Incoming callers identify a workspace; fork callers may provide its exact checkout. */
function resolveCheckout(input: ExplorerSidebarInput): ExplorerCheckoutContext | null {
  if (input.checkout) return input.checkout;
  if (!input.workspaceKey) return null;
  for (const [serverId, session] of Object.entries(useSessionStore.getState().sessions)) {
    const prefix = `${serverId}:`;
    if (!input.workspaceKey.startsWith(prefix)) continue;
    const workspace = session.workspaces.get(input.workspaceKey.slice(prefix.length));
    if (workspace?.workspaceDirectory)
      return {
        serverId,
        cwd: workspace.workspaceDirectory,
        isGit: workspace.projectKind === "git",
      };
  }
  return null;
}
