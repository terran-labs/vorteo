import type { RestartJob } from "@getpaseo/protocol/execution-installation";

/**
 * Whether an item under Settings > System waits on the owner (#656). Waiting items render open
 * with their one action; everything else sits in a collapsed section. Two guards hold
 * throughout: a state nobody classified is waiting, so a new status can never vanish into
 * History; and a failed record that still counts on System Health is always waiting.
 */
export type OwnerState = "waiting" | "in-progress" | "history";

/** Restart requests. `counted` is true for a failure System Health still counts. */
export function restartOwnerState(
  job: Pick<
    RestartJob,
    | "status"
    | "delegatedTo"
    | "delegationOverdue"
    | "automaticApproval"
    | "automaticDispatchAfter"
    | "holdDeadlineExceeded"
  >,
  counted = false,
): OwnerState {
  switch (job.status) {
    case "pending":
      // Another agent holds the decision, until it runs past its grace window.
      if (job.delegatedTo && !job.delegationOverdue) return "in-progress";
      // Only the request's own recorded policy fields say it is approved automatically.
      if (job.automaticApproval || job.automaticDispatchAfter) return "in-progress";
      return "waiting";
    case "approved":
    case "running":
      return job.holdDeadlineExceeded ? "waiting" : "in-progress";
    case "failed":
      return counted ? "waiting" : "history";
    case "succeeded":
    case "rejected":
      return "history";
    default:
      return "waiting";
  }
}

/** Broker, monitor, helper, session host and service maintenance records. */
export function jobOwnerState(
  job: { status: string; stage?: string },
  counted = false,
): OwnerState {
  if (job.stage === "recovery_required") return "waiting";
  switch (job.status) {
    case "pending":
      return "waiting";
    case "approved":
    case "running":
      return "in-progress";
    case "failed":
      return counted ? "waiting" : "history";
    case "succeeded":
    case "rejected":
    case "cancelled":
      return "history";
    default:
      return "waiting";
  }
}

/** Agent instruction changes: only a current pending request can be applied. */
export function instructionOwnerState(request: { status: string }, stale: boolean): OwnerState {
  if (request.status === "pending") return stale ? "history" : "waiting";
  if (["applied", "rejected", "stale", "cancelled"].includes(request.status)) return "history";
  return "waiting";
}

/** The plain line shown for a request that does not wait on the owner, without its reason. */
export function restartProgressLine(
  job: Pick<
    RestartJob,
    "status" | "update" | "sourceBatch" | "automaticApproval" | "automaticDispatchAfter"
  >,
): string | null {
  const automatic = Boolean(job.automaticApproval || job.automaticDispatchAfter);
  if (!automatic) return null;
  if (job.status === "pending") return "Preparing; it will be approved automatically";
  if (job.update || job.sourceBatch) return "Update installing; approved automatically";
  return "Restart running; approved automatically";
}
