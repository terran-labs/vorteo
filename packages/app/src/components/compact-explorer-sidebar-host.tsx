import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  CompactExplorerSidebar,
  NativeExplorerSidebarDock,
} from "@/components/compact-explorer-sidebar";
import { useOpenSettingsGesture } from "@/mobile-panels/gestures";
import { useIsMobilePanelActive } from "@/mobile-panels/provider";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { usePanelStore, selectIsCompactFileExplorerOpen } from "@/stores/panel-store";
import { useWorkspaceLayoutStore, findPaneById } from "@/stores/workspace-layout-store";
import { SupportingCardsContext } from "@/screens/workspace/supporting-cards-context";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useWorkspaceCheckoutStatus } from "@/screens/workspace/use-workspace-checkout-status";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import { useIsCompactFormFactor } from "@/constants/layout";
import { router, usePathname } from "expo-router";
import { buildSettingsRoute } from "@/utils/host-routes";
import { isWeb } from "@/constants/platform";
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import {
  resolveCompactExplorerSidebarHostModel,
  type CompactExplorerSidebarHostModel,
} from "@/components/compact-explorer-sidebar-host-state";

interface CompactSettingsOpenGestureSurfaceProps {
  children: ReactNode;
  enabled: boolean;
  onOpenSettings: () => void;
}

function CompactSettingsOpenGestureSurface({
  children,
  enabled,
  onOpenSettings,
}: CompactSettingsOpenGestureSurfaceProps) {
  const routeKey = usePathname();
  const { gesture: settingsOpenGesture, edgeRef } = useOpenSettingsGesture({
    enabled,
    routeKey,
    onOpen: onOpenSettings,
  });

  return (
    <GestureDetector gesture={settingsOpenGesture} touchAction={isWeb ? "auto" : "pan-y"}>
      <View ref={edgeRef} style={styles.fill}>
        {children}
      </View>
    </GestureDetector>
  );
}

function useActiveCompactExplorerSidebarModel(
  enabled: boolean,
): CompactExplorerSidebarHostModel | null {
  const selection = useActiveWorkspaceSelection();
  const workspace = useWorkspace(selection?.serverId ?? null, selection?.workspaceId ?? null);
  const isExplorerActive = useIsMobilePanelActive("file-explorer");
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const client = useHostRuntimeClient(selection?.serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(selection?.serverId ?? "");
  const retainedModelRef = useRef<CompactExplorerSidebarHostModel | null>(null);
  const { checkoutQuery } = useWorkspaceCheckoutStatus({
    client,
    isConnected,
    isRouteFocused: enabled && selection !== null,
    normalizedServerId: selection?.serverId ?? "",
    normalizedWorkspaceId: selection?.workspaceId ?? "",
    workspaceDirectory: workspace?.workspaceDirectory || null,
  });
  const resolvedModel = useMemo(
    () =>
      resolveCompactExplorerSidebarHostModel({
        previous: isExplorerActive ? retainedModelRef.current : null,
        selection,
        workspace,
        isGit: checkoutQuery.data?.isGit ?? false,
      }),
    [checkoutQuery.data?.isGit, isExplorerActive, selection, workspace],
  );

  useEffect(() => {
    if (!selection) {
      retainedModelRef.current = null;
      if (enabled && isExplorerActive) {
        showMobileAgent();
      }
      return;
    }
    if (!isExplorerActive) {
      retainedModelRef.current = null;
      return;
    }
    if (resolvedModel) {
      retainedModelRef.current = resolvedModel;
    }
  }, [enabled, isExplorerActive, resolvedModel, selection, showMobileAgent]);

  return selection ? (resolvedModel ?? (isExplorerActive ? retainedModelRef.current : null)) : null;
}

interface CompactExplorerSidebarHostProps {
  children: ReactNode;
  enabled: boolean;
  presentation: "overlay" | "dock";
}

export function CompactExplorerSidebarHost({
  children,
  enabled,
  presentation,
}: CompactExplorerSidebarHostProps) {
  const compact = useIsCompactFormFactor();
  const model = useActiveCompactExplorerSidebarModel(enabled);
  const cardHostName = `native-workspace-cards-${useId()}`;
  const explorerOpen = usePanelStore(selectIsCompactFileExplorerOpen);
  const activeAgentId = useWorkspaceLayoutStore((state) => {
    if (!model) return null;
    const layout = state.layoutByWorkspace[model.persistenceKey];
    if (!layout) return null;
    const pane = findPaneById(layout.root, layout.focusedPaneId);
    const tab = state
      .getWorkspaceTabs(model.persistenceKey)
      .find((entry) => entry.tabId === pane?.focusedTabId);
    return tab?.target.kind === "agent" ? tab.target.agentId : null;
  });
  const cardHostValue = useMemo(
    () => ({
      agentId: activeAgentId,
      hostName: enabled && presentation === "dock" && explorerOpen ? cardHostName : null,
    }),
    [activeAgentId, enabled, presentation, explorerOpen, cardHostName],
  );
  const [containerWidth, setContainerWidth] = useState(0);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const openTab = useWorkspaceLayoutStore((state) => state.openTab);
  const openWorkspaceTabInFocusedPane = useCallback(
    (workspaceKey: string, target: WorkspaceTabTarget) =>
      openTab({ workspaceKey, target, intent: "reveal" }),
    [openTab],
  );
  useWorkspaceLayoutStore((state) => state.focusTab);

  const handleOpenSettings = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);
  useEffect(() => {
    // Old callers or retained state must not reveal the removed phone drawer.
    if (compact && presentation === "overlay" && explorerOpen) showMobileAgent();
  }, [compact, presentation, explorerOpen, showMobileAgent]);

  const handleOpenFile = useCallback(
    (filePath: string) => {
      if (!model) {
        return;
      }
      openWorkspaceFileFromExplorer({
        filePath,
        persistenceKey: model.persistenceKey,
        openWorkspaceTabInFocusedPane,
        revealWorkspaceTab,
      });
      // The compact layout opens files in a sheet above Explorer (upstream #7693), so closing the
      // sheet uncovers the retained file list. Other overlays reveal the file's tab instead.
      const opensInSheet = useWorkspaceLayoutStore.getState().layoutMode === "compact";
      if (presentation === "overlay" && !opensInSheet) showMobileAgent();
    },
    [model, openWorkspaceTabInFocusedPane, presentation, showMobileAgent],
  );

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setContainerWidth((current) => (current === nextWidth ? current : nextWidth));
  }, []);

  const explorer =
    enabled && model && (!compact || presentation === "dock") ? (
      <DiffDocumentWorkspaceCacheProvider key={model.persistenceKey}>
        {presentation === "dock" ? (
          <NativeExplorerSidebarDock
            cardHostName={cardHostName}
            serverId={model.serverId}
            workspaceId={model.workspaceId}
            workspaceRoot={model.workspaceRoot}
            isGit={model.isGit}
            persistenceKey={model.persistenceKey}
            containerWidth={containerWidth}
            onOpenFile={handleOpenFile}
          />
        ) : (
          <CompactExplorerSidebar
            serverId={model.serverId}
            workspaceId={model.workspaceId}
            workspaceRoot={model.workspaceRoot}
            isGit={model.isGit}
            onOpenFile={handleOpenFile}
          />
        )}
      </DiffDocumentWorkspaceCacheProvider>
    ) : null;

  if (presentation === "dock") {
    return (
      <SupportingCardsContext.Provider value={cardHostValue}>
        <View style={styles.row} onLayout={handleContainerLayout}>
          <View style={styles.fill}>{children}</View>
          {explorer}
        </View>
      </SupportingCardsContext.Provider>
    );
  }

  return (
    <>
      <CompactSettingsOpenGestureSurface
        enabled={enabled && compact}
        onOpenSettings={handleOpenSettings}
      >
        {children}
      </CompactSettingsOpenGestureSurface>
      {explorer}
    </>
  );
}

const styles = {
  fill: {
    flex: 1,
  },
  row: {
    flex: 1,
    flexDirection: "row",
  },
} as const;
