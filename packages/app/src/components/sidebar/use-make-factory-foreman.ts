import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { useInstalledPlugins } from "@/plugins/registry";
import { useProjectFactory } from "./factory-instructions";
import { openFactoryDialog, type ProjectFactoryState } from "./project-factory";
import { canMakeFactoryForeman } from "./project-factory-model";

/**
 * "Make this thread the Foreman" for a thread tab (#360). Returns the action only where the
 * daemon would accept the adoption (see canMakeFactoryForeman); it opens a confirmation that
 * turns on Factory with this thread adopted as the Foreman.
 */
export function useMakeFactoryForeman(
  serverId: string,
  workspaceId: string,
  agentId: string | null,
) {
  // Select primitives only, compared with useShallow. A fresh object on every call changes the
  // store snapshot each render and loops React (the #625 browser suite failure), and the labels
  // record is parsed anew on every agent update, so it would re-render each tab on every update.
  const thread = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agents.get(agentId ?? "");
      if (!agent) return null;
      return {
        projectId: session?.workspaces.get(agent.workspaceId ?? workspaceId)?.projectId ?? "",
        cwd: agent.cwd,
        factoryRole: agent.labels["vorteo.factory-role"] ?? null,
        archived: Boolean(agent.archivedAt),
      };
    }),
  );
  const projectId = thread?.projectId ?? "";
  // Read Factory state only for a thread wearing this project's Foreman label.
  const labelled = !!projectId && thread?.factoryRole === `${projectId}:factory-intake`;
  const factory = useProjectFactory(serverId, projectId, labelled && !!agentId, {
    refetchInterval: false,
  });
  const plugin = useInstalledPlugins().find((p) => p.id === "factory" && p.serverId === serverId);
  const client = useQueryClient();
  const eligible =
    !!thread &&
    !!projectId &&
    canMakeFactoryForeman({
      projectId,
      labels: thread.factoryRole ? { "vorteo.factory-role": thread.factoryRole } : undefined,
      archived: thread.archived,
      factory: factory.data,
    });
  const open = useCallback(() => {
    if (!plugin || !agentId || !thread) return;
    void openFactoryDialog({
      action: "enable",
      serverId,
      projectId,
      projectPath: thread.cwd,
      repository: factory.data?.repository ?? null,
      invoke: plugin.invoke,
      adoptForeman: agentId,
      onResult: (state: ProjectFactoryState) =>
        client.setQueryData(["projectFactory", serverId, projectId], state),
    });
  }, [plugin, agentId, thread, serverId, projectId, factory.data?.repository, client]);
  return eligible && plugin ? open : undefined;
}
