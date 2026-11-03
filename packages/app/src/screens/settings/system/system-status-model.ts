import type { RestartJob, RestartSummary } from "@getpaseo/protocol/execution-installation";
import type { InstallationEnrollmentStatus } from "@getpaseo/protocol/installation-enrollment";
import type { InstallationUpgrade } from "@getpaseo/protocol/installation-upgrades";
import type { MaintenanceServiceQueueStatus } from "@getpaseo/protocol/maintenance-service-status";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";
import { maintenanceHeadline } from "@/execution-installation/maintenance-dashboard-model";

export type SystemStatus = "healthy" | "updating" | "attention";
export interface SystemAction {
  kind: "approve-restart" | "approve-upgrade" | "reconnect" | "update";
  label: string;
  id?: string;
  mode?: "finish-current-turns";
}
export interface SystemEnvironmentInput {
  target: "host" | "container-daemon";
  connection: Pick<HostRuntimeSnapshot, "connectionStatus" | "lastError">;
  enrollment?: InstallationEnrollmentStatus | null;
  restartJobs?: readonly Pick<RestartJob, "id" | "target" | "status" | "reason">[];
  upgrades?: readonly Pick<InstallationUpgrade, "id" | "status" | "release">[];
  serviceQueue?: Pick<MaintenanceServiceQueueStatus, "jobs">;
  /** Public counts are installation-wide and cannot safely be attributed to one target. */
  locked?: boolean;
  restartSummary?: RestartSummary;
  reconnectingAfterAction?: boolean;
  availableVersion?: string | null;
}
// oxlint-disable-next-line complexity -- Enumerates independent public status signals in precedence order.
export function deriveSystemEnvironment(input: SystemEnvironmentInput): {
  status: SystemStatus;
  action: SystemAction | null;
  reason?: string;
} {
  const { connection, enrollment } = input;
  const offline = ["offline", "error", "idle"].includes(connection.connectionStatus);
  const jobs = input.locked
    ? []
    : (input.restartJobs ?? []).filter((job) => job.target === input.target);
  const upgrades = input.locked ? [] : (input.upgrades ?? []);
  const waiting = jobs.find((job) => job.status === "pending");
  const upgrade = upgrades.find((job) => job.status === "pending");
  const counts = input.locked ? input.restartSummary : undefined;
  const activeJob = jobs.find((job) => job.status === "approved" || job.status === "running");
  // Installation upgrades cover Host and Dev; restart jobs are filtered by target above.
  const activeUpgrade = upgrades.some(
    (job) => job.status === "approved" || job.status === "running",
  );
  const activeWork = Boolean(activeJob) || activeUpgrade;
  const attention =
    ((offline || Boolean(connection.lastError)) && !activeWork) ||
    enrollment?.activation === "recovery-required" ||
    enrollment?.services.some(
      (service) => service.target === input.target && service.readiness === "blocked",
    ) ||
    jobs.some((job) => job.status === "pending" || job.status === "failed") ||
    Boolean(upgrade) ||
    Boolean(counts?.requested) ||
    (Boolean(input.availableVersion) && !activeWork);
  const updating =
    input.reconnectingAfterAction ||
    activeWork ||
    input.serviceQueue?.jobs.some((job) => job.status === "running") ||
    Boolean(counts && (counts.queued || counts.running));
  let action: SystemAction | null = null;
  if (activeWork) action = null;
  else if (offline) action = { kind: "reconnect", label: "Reconnect" };
  else if (waiting)
    action = {
      kind: "approve-restart",
      id: waiting.id,
      label: "Approve restart",
      mode: "finish-current-turns",
    };
  else if (upgrade)
    action = {
      kind: "approve-upgrade",
      id: upgrade.id,
      label: "Approve update",
      mode: "finish-current-turns",
    };
  else if (input.availableVersion)
    action = { kind: "update", label: `Update to ${input.availableVersion}` };
  let status: SystemStatus = "healthy";
  if (updating) status = "updating";
  if (attention) status = "attention";
  const reason =
    waiting?.reason || activeJob?.reason || (upgrade ? `Update to ${upgrade.release}` : undefined);
  return { status, action, ...(reason ? { reason } : {}) };
}

/** Hidden when ready; maintenance authority and service health remain separate. */
export function deriveSystemServices(
  enrollment: InstallationEnrollmentStatus,
): SystemStatus | null {
  const headline = maintenanceHeadline(enrollment);
  if (headline.label === "Ready") return null;
  return headline.variant === "error" || headline.variant === "muted" ? "attention" : "updating";
}
