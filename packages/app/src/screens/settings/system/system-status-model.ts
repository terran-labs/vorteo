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
  const attention =
    offline ||
    Boolean(connection.lastError) ||
    enrollment?.activation === "recovery-required" ||
    enrollment?.services.some(
      (service) => service.target === input.target && service.readiness === "blocked",
    ) ||
    jobs.some((job) => job.status === "pending" || job.status === "failed") ||
    Boolean(upgrade) ||
    Boolean(counts?.requested) ||
    Boolean(input.availableVersion);
  const updating =
    input.reconnectingAfterAction ||
    jobs.some((job) => job.status === "approved" || job.status === "running") ||
    upgrades.some((job) => job.status === "approved" || job.status === "running") ||
    input.serviceQueue?.jobs.some((job) => job.status === "running") ||
    Boolean(counts && (counts.queued || counts.running));
  let action: SystemAction | null = null;
  if (waiting)
    action = {
      kind: "approve-restart",
      id: waiting.id,
      label: waiting.reason || "Approve restart",
      mode: "finish-current-turns",
    };
  else if (upgrade)
    action = {
      kind: "approve-upgrade",
      id: upgrade.id,
      label: `Approve update to ${upgrade.release}`,
      mode: "finish-current-turns",
    };
  else if (offline) action = { kind: "reconnect", label: "Reconnect" };
  else if (input.availableVersion)
    action = { kind: "update", label: `Update to ${input.availableVersion}` };
  let status: SystemStatus = "healthy";
  if (updating) status = "updating";
  if (attention) status = "attention";
  return { status, action };
}

/** Hidden when ready; maintenance authority and service health remain separate. */
export function deriveSystemServices(
  enrollment: InstallationEnrollmentStatus,
): SystemStatus | null {
  const headline = maintenanceHeadline(enrollment);
  if (headline.label === "Ready") return null;
  return headline.variant === "error" || headline.variant === "muted" ? "attention" : "updating";
}
