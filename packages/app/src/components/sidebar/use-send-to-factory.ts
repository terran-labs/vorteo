import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { useInstalledPlugins } from "@/plugins/registry";
import { useToast } from "@/contexts/toast-context";
import { useProjectFactory } from "./factory-instructions";
import { sendThreadToFactory } from "./project-factory-model";
export function useSendToFactory(serverId: string, workspaceId: string, agentId: string | null) {
  const projectId = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId ?? "");
    if (!agent) return "";
    return session?.workspaces.get(agent.workspaceId ?? workspaceId)?.projectId ?? "";
  });
  const factory = useProjectFactory(serverId, projectId, !!projectId && !!agentId, {
    refetchInterval: false,
  });
  const plugin = useInstalledPlugins().find((p) => p.id === "factory" && p.serverId === serverId);
  const toast = useToast();
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const send = useCallback(async () => {
    if (!plugin || !agentId || pending) return;
    setPending(true);
    try {
      await sendThreadToFactory(plugin.invoke, projectId, agentId);
      toast.show(t("projectFactory.sent"), { variant: "success" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("projectFactory.failed"));
    } finally {
      setPending(false);
    }
  }, [plugin, agentId, pending, projectId, toast, t]);
  return projectId && agentId && factory.data?.state === "on" ? send : undefined;
}
