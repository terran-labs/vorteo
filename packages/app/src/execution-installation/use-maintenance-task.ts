import { useCallback } from "react";
import { useRouter } from "expo-router";
import { useToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { useDraftStore } from "@/stores/draft-store";
import { buildNewWorkspaceDraftKey, generateDraftId } from "@/stores/draft-keys";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { getIsElectron, isWeb } from "@/constants/platform";
import { isDemoSession } from "@/demo/mode";
import { isIsolatedDemoPreview } from "@/demo/preview";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { readExecutionInstallation } from "./policy";
import {
  installationMaintenancePrompt,
  maintenanceTaskTarget,
  resolveMaintenanceTaskTarget,
  type MaintenanceTaskTarget,
} from "./maintenance-task";

/**
 * Only a page served by an installation can prove the descriptor is absent. Electron, native
 * apps and demos connect to daemons directly and never receive one.
 */
function descriptorExpected(): boolean {
  return isWeb && !getIsElectron() && !isDemoSession() && !isIsolatedDemoPreview;
}

/** Whether update and merge tasks can target a Host, for pages that explain the alternative. */
export function useMaintenanceTaskTarget(): MaintenanceTaskTarget {
  const hosts = useHosts();
  return resolveMaintenanceTaskTarget(
    readExecutionInstallation(),
    hosts.map((host) => host.serverId),
    descriptorExpected(),
  );
}

export interface MaintenanceTaskOptions {
  /**
   * Open the draft in the active project when that project belongs to the Host.
   * A Dev project's path means nothing on the Host, so other projects fall back to
   * the Host's default new workspace page.
   */
  inActiveProject?: boolean;
}

export function useMaintenanceTask() {
  const router = useRouter();
  const toast = useToast();
  const hosts = useHosts();
  const selection = useActiveWorkspaceSelection();
  const activeWorkspace = useWorkspace(selection?.serverId ?? null, selection?.workspaceId ?? null);
  return useCallback(
    (prompt: string, options: MaintenanceTaskOptions = {}) => {
      try {
        const serverId = maintenanceTaskTarget(
          readExecutionInstallation(),
          hosts.map((host) => host.serverId),
          descriptorExpected(),
        );
        const draftId = generateDraftId();
        useDraftStore.getState().saveDraftInput({
          draftKey: buildNewWorkspaceDraftKey(draftId),
          draft: { text: installationMaintenancePrompt(prompt), attachments: [] },
        });
        // Saving and navigating prepares an editable draft. It never creates an agent.
        const project =
          options.inActiveProject && activeWorkspace && selection?.serverId === serverId
            ? {
                sourceDirectory: activeWorkspace.projectRootPath,
                projectId: activeWorkspace.projectId,
              }
            : {};
        router.push(buildNewWorkspaceRoute({ draftId, serverId, ...project }));
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [hosts, router, toast, activeWorkspace, selection?.serverId],
  );
}
