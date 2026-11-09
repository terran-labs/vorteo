import { maintenanceHeadline } from "@/execution-installation/maintenance-dashboard-model";
import type { ExecutionInstallation } from "@getpaseo/protocol/execution-installation";
import type { HostProfile } from "@/types/host-connection";
import type { InstallationPanelModel } from "@/execution-installation/panel-model";
import type { InstallationUpgrade } from "@getpaseo/protocol/installation-upgrades";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";
import type { HostRuntimeSnapshot } from "@/runtime/host-runtime";
import { deriveSystemEnvironment, deriveSystemServices } from "./system-status-model";

export type InstallationSystemState = ReturnType<InstallationPanelModel["getState"]>;
export type SystemTarget = "host" | "container-daemon";
/** Finished requests remain in history; an old failed request must not mask a later success. */
export function currentSystemRestarts(state: InstallationSystemState): RestartJob[] {
  if (!state.unlocked) return [];
  const pending = new Set(state.pendingJobs.map((job) => job.id));
  const current = state.jobs.filter(
    (job) => pending.has(job.id) || job.status === "approved" || job.status === "running",
  );
  for (const target of ["host", "container-daemon"] as const) {
    if (current.some((job) => job.target === target)) continue;
    const latest = state.jobs
      .filter((job) => job.target === target)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest?.status === "failed") current.push(latest);
  }
  return current;
}
export function systemEnvironmentState(input: {
  target: SystemTarget;
  snapshot: HostRuntimeSnapshot | null;
  installation: InstallationSystemState | null;
  upgrades?: readonly InstallationUpgrade[];
  availableVersion?: string | null;
  reconnectingAfterAction?: boolean;
}) {
  const unlocked = input.installation?.unlocked === true;
  return deriveSystemEnvironment({
    target: input.target,
    connection: input.snapshot ?? { connectionStatus: "connecting", lastError: null },
    locked: !unlocked,
    restartSummary: input.installation?.restartSummary ?? undefined,
    enrollment: unlocked ? input.installation?.enrollmentStatus : undefined,
    liveDev: unlocked && input.target === "host" ? input.installation?.liveDev : undefined,
    restartJobs: input.installation ? currentSystemRestarts(input.installation) : [],
    upgrades: unlocked ? input.upgrades : undefined,
    serviceQueue: unlocked ? (input.installation?.serviceQueue ?? undefined) : undefined,
    availableVersion: input.availableVersion,
    reconnectingAfterAction: input.reconnectingAfterAction,
  });
}
export function systemServicesState(state: InstallationSystemState | null) {
  if (!state) return null;
  if (state.unlocked)
    return state.enrollmentStatus ? deriveSystemServices(state.enrollmentStatus) : null;
  const summary = state.restartSummary;
  if (!summary) return null;
  if (publicAttentionCount({ ...summary, requested: 0 }) > 0) return "attention";
  const updating = publicServices(summary).some(
    (service) =>
      service &&
      (service.queued > 0 ||
        ("running" in service && typeof service.running === "number" && service.running > 0) ||
        ("unverified" in service &&
          typeof service.unverified === "number" &&
          service.unverified > 0)),
  );
  return updating ? "updating" : null;
}
function publicServices(summary: NonNullable<InstallationSystemState["restartSummary"]>) {
  return [
    summary.serviceMaintenance,
    summary.nativeHelper,
    summary.previewBroker,
    summary.previewBrokerDeployment,
    summary.previewMonitor,
    summary.sessionHost,
  ];
}

function requiresReview(job: { status: string; stage?: string }): boolean {
  return ["pending", "failed"].includes(job.status) || job.stage === "recovery_required";
}
function publicAttentionCount(summary: InstallationSystemState["restartSummary"]): number {
  if (!summary) return 0;
  const services = publicServices(summary);
  return (
    summary.requested +
    services.reduce((total, service) => {
      if (!service) return total;
      const recovery =
        "recovery" in service && typeof service.recovery === "number" ? service.recovery : 0;
      const attention = "attention" in service ? service.attention : 0;
      return total + service.requested + recovery + attention;
    }, 0)
  );
}
/** Only protected receipts while unlocked, only public summary counts while locked. */
export function systemAttentionCount(
  state: InstallationSystemState,
  upgrades: readonly InstallationUpgrade[] = [],
): number {
  if (!state.unlocked) return publicAttentionCount(state.restartSummary);
  const queues = [
    currentSystemRestarts(state),
    state.helperJobs,
    state.brokerJobs,
    state.monitorJobs,
    state.serviceQueue?.jobs ?? [],
    state.sessionHost?.jobs ?? [],
    state.instructionRequests?.requests ?? [],
    upgrades.filter((upgrade) => !upgrade.acknowledgedAt),
  ];
  const requests = queues.reduce((total, queue) => total + queue.filter(requiresReview).length, 0);
  const blockedServices =
    state.enrollmentStatus?.services.filter((service) => service.readiness === "blocked").length ??
    0;
  return (
    requests +
    blockedServices +
    Number(state.enrollmentStatus?.activation === "recovery-required") +
    Number(state.liveDev?.mode === "live" && state.liveDev.server.state === "failed")
  );
}

export function selectSystemEnvironments(
  installation: ExecutionInstallation | null,
  hosts: readonly Pick<HostProfile, "serverId">[],
  serverId?: string,
  selectedServerId?: string | null,
) {
  return {
    hostId:
      serverId ??
      installation?.environments.find((environment) => environment.kind === "host")?.serverId ??
      hosts.find((host) => host.serverId === selectedServerId)?.serverId ??
      hosts[0]?.serverId ??
      null,
    devId:
      installation?.environments.find((environment) => environment.kind === "container")
        ?.serverId ?? null,
  };
}

/** Public summaries describe the installation, never an inferred Host or Dev failure. */
export function systemServicesReason(state: InstallationSystemState | null): string | undefined {
  if (!state) return undefined;
  if (state.unlocked && state.enrollmentStatus)
    return maintenanceHeadline(state.enrollmentStatus).explanation;
  if (!state.restartSummary) return undefined;
  const count = publicAttentionCount({ ...state.restartSummary, requested: 0 });
  if (count > 0)
    return `${count} installation service items need review. Unlock System controls in Details to see their reasons.`;
  if (systemServicesState(state) === "updating")
    return "Installation service maintenance is queued, running or awaiting verification.";
  return undefined;
}
