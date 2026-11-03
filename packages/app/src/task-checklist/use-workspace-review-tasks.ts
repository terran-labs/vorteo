import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { usePendingArchiveAgentIds } from "@/hooks/use-archive-agent";
import { selectSystemManaged } from "@/workspace/lifecycle/system-membership";
import type { TodoEntry } from "@/types/stream";
import { workspaceReviewTasks } from "./review-wait";

const NO_TASKS: TodoEntry[] = [];

/** Review items the workspace's threads are waiting on, with the flower's visibility rules. */
export function useWorkspaceReviewTasks(serverId: string, workspaceId: string): TodoEntry[] {
  const pending = usePendingArchiveAgentIds(serverId);
  return useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      if (!session?.serverInfo?.features?.agentTaskSnapshots) return NO_TASKS;
      if (selectSystemManaged(state, serverId, workspaceId)) return NO_TASKS;
      return workspaceReviewTasks(session.agents.values(), workspaceId, pending);
    }),
  );
}
