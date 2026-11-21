import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export function useSharedFilesSupported(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceSharedFiles === true,
  );
}

/** Files exchanged across the workspace's threads, newest first. */
export function useSharedFiles(input: { serverId: string; workspaceId: string; enabled: boolean }) {
  const { serverId, workspaceId, enabled } = input;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: 15_000,
    queryKey: ["shared-files", serverId, workspaceId] as const,
    enabled: enabled && connected && client !== null,
    queryFn: async () => {
      if (!client) throw new Error("Reconnect to load shared files.");
      return client.listWorkspaceSharedFiles(workspaceId);
    },
  });
}
