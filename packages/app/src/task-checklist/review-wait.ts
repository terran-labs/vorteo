import type { TodoEntry } from "@/types/stream";
import type { Agent } from "@/stores/session-store";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

/** Tooltip rows stay bounded; the rest are summarized as a count. */
export const MAX_REVIEW_WAIT_ROWS = 3;

/** Unfinished Review items across the workspace's live threads, in thread order. */
export function workspaceReviewTasks(
  agents: Iterable<Pick<Agent, "id" | "workspaceId" | "archivedAt" | "tasks">>,
  workspaceId: string,
  pendingArchive: ReadonlySet<string>,
): TodoEntry[] {
  const tasks: TodoEntry[] = [];
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId || agent.archivedAt || pendingArchive.has(agent.id)) {
      continue;
    }
    for (const task of agent.tasks ?? []) {
      if (task.status === "review" && !task.completed) tasks.push(task);
    }
  }
  return tasks;
}

/**
 * A row waiting on someone else's review should not read as ready. Only idle states give way:
 * running, needs-input and failed rows report something more urgent than the wait.
 */
export function showsReviewWait(bucket: SidebarStateBucket, reviewCount: number): boolean {
  return reviewCount > 0 && (bucket === "attention" || bucket === "done");
}

export interface ReviewWaitSummary {
  heading: string;
  rows: { key: string; title: string; detail: string | null }[];
  more: number;
}

/** "Waiting on <owner>" when every item names the same owner, otherwise a generic heading. */
export function reviewWaitSummary(tasks: readonly TodoEntry[]): ReviewWaitSummary {
  const owners = new Set(tasks.map((task) => task.owner?.trim() || ""));
  const [owner] = owners;
  const heading = owners.size === 1 && owner ? `Waiting on ${owner}` : "Waiting for review";
  const rows = tasks.slice(0, MAX_REVIEW_WAIT_ROWS).map((task) => ({
    key: task.id ?? task.text,
    title: task.text,
    detail: task.description?.trim() || null,
  }));
  return { heading, rows, more: Math.max(0, tasks.length - MAX_REVIEW_WAIT_ROWS) };
}
