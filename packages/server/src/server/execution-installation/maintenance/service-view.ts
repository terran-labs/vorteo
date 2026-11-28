import type { MaintenanceServiceJob } from "@getpaseo/protocol/maintenance-service";
import type { MaintenanceServiceView } from "@getpaseo/protocol/maintenance-service-status";

type ServiceProgress = Pick<
  MaintenanceServiceView,
  "startedAt" | "step" | "stepStartedAt" | "finishedAt"
>;

/**
 * Start, step and finish from timestamps the maintenance journal already keeps, so they are as
 * durable as the job itself. Unknown times stay absent rather than borrowed from another field.
 */
function serviceProgress(job: MaintenanceServiceJob): ServiceProgress {
  const startedAt = job.reservation?.reservedAt;
  const observedAt = job.observation?.observedAt;
  const started = startedAt ? { startedAt } : {};
  if (job.status === "pending") return { step: "awaiting-approval", stepStartedAt: job.createdAt };
  if (job.status === "succeeded" || job.status === "failed" || job.status === "rejected") {
    return { ...started, step: job.status, ...(observedAt ? { finishedAt: observedAt } : {}) };
  }
  if (observedAt) return { ...started, step: "observing", stepStartedAt: observedAt };
  if (startedAt) return { ...started, step: "running", stepStartedAt: startedAt };
  const approvedAt = job.approval?.approvedAt;
  return { step: "waiting-to-start", ...(approvedAt ? { stepStartedAt: approvedAt } : {}) };
}

// COMPAT(operationProgress): added 2026-11-28; the progress fields go only to clients that send
// operationProgress=1, since the view schema is strict for older clients.
export function maintenanceServiceView(
  job: MaintenanceServiceJob,
  operationProgress = false,
): MaintenanceServiceView {
  return {
    id: job.id,
    revision: job.revision,
    target: job.target,
    operation: job.operation,
    reason: job.reason,
    createdAt: job.createdAt,
    status: job.status,
    detail: job.detail,
    cancelable: !job.reservation && (job.status === "pending" || job.status === "approved"),
    dispatchAfter: job.approval?.dispatchAfter ?? null,
    generation: job.reservation?.generation ?? null,
    outcome: job.observation?.outcome ?? null,
    observedAt: job.observation?.observedAt ?? null,
    ...(operationProgress ? serviceProgress(job) : {}),
  };
}
