import {
  CustomDomainStatusSchema,
  type CustomDomainStatus,
} from "@getpaseo/protocol/custom-domain";
import {
  InstallationTypeStatusSchema,
  type InstallationType,
  type InstallationTypeStatus,
} from "@getpaseo/protocol/installation-type";
import {
  LiveDevStatusSchema,
  type LiveDevMode,
  type LiveDevStatus,
} from "@getpaseo/protocol/live-dev";
import {
  PreviewBrokerDeploymentJobSchema,
  type PreviewBrokerDeploymentJob,
} from "@getpaseo/protocol/preview-broker-deployment";
import {
  PreviewBrokerJobSchema,
  type PreviewBrokerJob,
} from "@getpaseo/protocol/preview-broker-maintenance";
import type { BrokerAction } from "./preview-broker-review";
import {
  MaintenanceDelegationStatusSchema,
  type MaintenanceDelegationStatus,
} from "@getpaseo/protocol/maintenance-approval";
import {
  NativeHelperJobSchema,
  type NativeHelperJob,
} from "@getpaseo/protocol/native-helper-maintenance";
import {
  MaintenanceServiceQueueStatusSchema,
  MaintenanceServiceViewSchema,
  type MaintenanceServiceView,
  type MaintenanceServiceQueueStatus,
} from "@getpaseo/protocol/maintenance-service-status";
import {
  InstallationEnrollmentStatusSchema,
  InstallationRecoveryAccessStatusSchema,
  type InstallationRecoveryAccessStatus,
  type InstallationEnrollmentStatus,
} from "@getpaseo/protocol/installation-enrollment";
import {
  PreviewMonitorJobSchema,
  type PreviewMonitorJob,
} from "@getpaseo/protocol/preview-monitor-maintenance";
import {
  SessionHostJobSchema,
  SessionHostStatusSchema,
  type SessionHostJob,
  type SessionHostOperation,
} from "@getpaseo/protocol/session-host-maintenance";
import {
  InstructionRequestQuerySchema,
  type InstructionRequestQuery,
} from "@getpaseo/protocol/instruction-requests";

import {
  AgentActionReceiptsSchema,
  QueuedAgentActionSchema,
  QueuedAgentActionsSchema,
  SourceUpgradeSchema,
  SourceUpgradeStatusSchema,
  CoordinatorFollowJobSchema,
  CoordinatorFollowStatusSchema,
  CoordinatorSettingsJobSchema,
  CoordinatorSettingsStatusSchema,
  InstallationSnapshotSchema,
  InstallationUpgradeSchema,
  SnapshotListSchema,
  SnapshotRestoreStatusSchema,
  UpgradeStatusSchema,
  type AgentActionReceipt,
  type QueuedAgentAction,
  type SourceUpgrade,
  type SourceUpgradeDecision,
  type SourceUpgradeStatus,
  type CoordinatorFollowDecision,
  type CoordinatorFollowJob,
  type CoordinatorFollowStatus,
  type CoordinatorSettingsDecision,
  type CoordinatorSettingsJob,
  type CoordinatorSettingsStatus,
  type InstallationSnapshot,
  type InstallationUpgrade,
  type ReleaseTag,
  type SnapshotList,
  type SnapshotPartKind,
  type SnapshotRestoreStatus,
  type UpdatePolicyChange,
  type UpgradeDecision,
  type UpgradeStatus,
} from "@getpaseo/protocol/installation-upgrades";

type InstructionRequestView = InstructionRequestQuery["requests"][number];
import type { MonitorAction } from "./preview-monitor-review";
import type { SessionHostAction, SessionHostOverview } from "./session-host-review";
import type { HelperReviewAction } from "./helper-review";
import { z } from "zod";
import {
  InstallationMaintenanceStatusSchema,
  type InstallationMaintenanceStatus,
  DaemonAutomationPreferenceSchema,
  type DaemonAutomationPreference,
  type MaintenanceService,
  InstallationUnlockSchema,
  RestartSummarySchema,
  type RestartSummary,
  RestartJobSchema,
  ProfileSharingStatusSchema,
  type ProfileSharingStatus,
  type ExecutionInstallation,
  type RestartJob,
  type RestartDecision,
} from "@getpaseo/protocol/execution-installation";
import type { HostRuntimeStore } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { normalizeHostPort } from "@getpaseo/protocol/daemon-endpoints";
import { restartPlanBindings } from "./restart-operations";

export function hasInstallationConnections(
  installation: ExecutionInstallation,
  profiles: readonly Pick<HostProfile, "serverId" | "connections" | "password">[],
): boolean {
  return installation.environments.every((environment) => {
    const scheme = environment.useTls ? "https" : "http";
    const address = new URL(`${scheme}://${environment.endpoint}`);
    const port = address.port || (environment.useTls ? "443" : "80");
    const endpoint = normalizeHostPort(`${address.hostname}:${port}`);
    const profile = profiles.find((candidate) => candidate.serverId === environment.serverId);
    return (
      profile?.connections.some((connection) => {
        if (connection.type !== "directTcp") return false;
        return (
          connection.endpoint === endpoint &&
          connection.useTls === environment.useTls &&
          Boolean(profile.password)
        );
      }) ?? false
    );
  });
}

export interface InstallationClientPorts {
  now?(): number;
  request(path: string, password: string, body: unknown): Promise<unknown>;
  register: Pick<HostRuntimeStore, "installExecutionEnvironments">;
}

export class OwnerAccessExpired extends Error {}
export class InstallationRouteUnavailable extends Error {}
/** A coordinator reply that was not OK, with its HTTP status for callers that branch on it. */
export class InstallationRequestFailed extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The same schema with every object, however nested, accepting unknown keys. The wire schemas
 * stay strict for the coordinator that writes them; this interface reads with tolerance so a
 * coordinator that adds a field never breaks an older interface again. Unknown keys are kept, as
 * the strict parse kept known ones, and never read.
 */
function tolerant<T extends z.ZodType>(schema: T): z.ZodType<z.output<T>> {
  return loosen(schema) as z.ZodType<z.output<T>>;
}

function loosen(schema: z.ZodType): z.ZodType {
  switch ((schema.def as { type: string }).type) {
    case "object": {
      const shape = (schema as z.ZodObject).shape as Record<string, z.ZodType>;
      return z.looseObject(
        Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, loosen(value)])),
      );
    }
    case "array":
      return z.array(loosen((schema as z.ZodArray<z.ZodType>).element));
    case "optional":
      return loosen((schema as z.ZodOptional<z.ZodType>).unwrap()).optional();
    case "nullable":
      return loosen((schema as z.ZodNullable<z.ZodType>).unwrap()).nullable();
    default:
      return schema;
  }
}

/** The owner's session host query as this interface reads it: tolerant of later additions. */
const SESSION_HOST_OVERVIEW_READER: z.ZodType<SessionHostOverview> = tolerant(
  z.strictObject({
    jobs: z.array(SessionHostJobSchema),
    // Null when the coordinator could not inspect the job; its jobs still need decisions.
    status: SessionHostStatusSchema.nullable(),
    // COMPAT(sessionHostRestart): absent from coordinators without the restart operation.
    restartSupported: z.boolean().optional(),
  }),
);

const SNAPSHOT_LIST_READER = tolerant(SnapshotListSchema);
const SNAPSHOT_READER = tolerant(InstallationSnapshotSchema);
const SNAPSHOT_RESTORE_READER = tolerant(SnapshotRestoreStatusSchema);
const UPGRADE_STATUS_READER = tolerant(UpgradeStatusSchema);
const UPGRADE_READER = tolerant(InstallationUpgradeSchema);
const COORDINATOR_FOLLOW_STATUS_READER = tolerant(CoordinatorFollowStatusSchema);
const AGENT_ACTIONS_READER = tolerant(AgentActionReceiptsSchema);
const INSTALLATION_CHANGES_READER = tolerant(QueuedAgentActionsSchema);
const INSTALLATION_CHANGE_READER = tolerant(QueuedAgentActionSchema);
const SOURCE_UPGRADE_STATUS_READER = tolerant(SourceUpgradeStatusSchema);
const SOURCE_UPGRADE_READER = tolerant(SourceUpgradeSchema);
const COORDINATOR_FOLLOW_READER = tolerant(CoordinatorFollowJobSchema);
const COORDINATOR_SETTINGS_STATUS_READER = tolerant(CoordinatorSettingsStatusSchema);
const COORDINATOR_SETTINGS_READER = tolerant(CoordinatorSettingsJobSchema);

export class InstallationClient {
  private password: string | null = null;
  private helperRetryAt = 0;
  private instructionRetryAt = 0;
  private daemonAutomationSupported = false;
  private servicePermissionsSupported = false;
  private maintenanceStatusSupported = false;
  private enrollmentStatusSupported = false;
  private recoveryAccessSupported = false;
  private devRepairSupported = false;
  private devRepairAvailable = false;
  private monitorRetryAt = 0;
  private brokerRetryAt = 0;
  private brokerDeploymentRetryAt = 0;
  private sessionHostRetryAt = 0;
  private sessionHostSupported = false;
  sessionsSupported = false;
  passwordFile: string | null = null;

  async restoreSession(): Promise<boolean> {
    const response = await fetch("/api/installation/owner-access", {
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error("Unable to check installation owner access");
    const metadata = z
      .strictObject({ sessions: z.literal(true), passwordFile: z.string().nullable() })
      .parse(await response.json());
    this.sessionsSupported = true;
    this.passwordFile = metadata.passwordFile;
    const session = z
      .strictObject({ authenticated: z.boolean(), expiresAt: z.string().nullable() })
      .parse(await this.ports.request("session", "", {}));
    if (!session.authenticated) return false;
    await this.installConnections(await this.ports.request("connections", "", {}));
    this.password = "";
    return true;
  }

  async lock(): Promise<void> {
    if (this.sessionsSupported) await this.request("lock", {});
    this.password = null;
  }

  constructor(
    private readonly installation: ExecutionInstallation,
    private readonly ports: InstallationClientPorts,
  ) {}

  async unlock(password: string): Promise<void> {
    await this.installConnections(await this.ports.request("unlock", password, {}));
    this.password = this.sessionsSupported ? "" : password;
  }

  private async installConnections(payload: unknown): Promise<void> {
    const result = InstallationUnlockSchema.parse(payload);
    if (result.installationId !== this.installation.installationId)
      throw new Error("Installation identity changed");
    for (const environment of this.installation.environments) {
      const connection = result.connections.find(
        (candidate) => candidate.kind === environment.kind,
      );
      if (
        !connection ||
        connection.serverId !== environment.serverId ||
        connection.endpoint !== environment.endpoint ||
        connection.useTls !== environment.useTls
      ) {
        throw new Error("Installation connection does not match its reviewed environment");
      }
    }
    await this.ports.register.installExecutionEnvironments(result.connections);
  }

  async restartSummary(): Promise<RestartSummary | null> {
    if (!this.installation.idleRestarts) return null;
    const response = await fetch("/api/installation/restart-summary", {
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Unable to check restart requests");
    return RestartSummarySchema.parse(await response.json());
  }

  async listBrokers(): Promise<PreviewBrokerJob[]> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const now = this.ports.now ?? Date.now;
    if (now() < this.brokerRetryAt) return [];
    try {
      return z
        .strictObject({ jobs: z.array(PreviewBrokerJobSchema) })
        .parse(await this.request("broker-rebinds/query", {})).jobs;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable) {
        this.brokerRetryAt = now() + 60_000;
        return [];
      }
      throw error;
    }
  }
  async decideBroker(job: PreviewBrokerJob, decision: BrokerAction): Promise<PreviewBrokerJob> {
    const result = PreviewBrokerJobSchema.parse(
      await this.request("broker-rebinds/decision", {
        operation: job.operation,
        id: job.id,
        revision: job.revision,
        planSha256: job.planSha256,
        decision,
      }),
    );
    if (
      result.id !== job.id ||
      result.revision !== job.revision ||
      result.planSha256 !== job.planSha256
    )
      throw new Error("Broker receipt changed. Refresh before another action.");
    return result;
  }
  async listBrokerDeployments(): Promise<PreviewBrokerDeploymentJob[]> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const now = this.ports.now ?? Date.now;
    if (now() < this.brokerDeploymentRetryAt) return [];
    try {
      return z
        .strictObject({ jobs: z.array(PreviewBrokerDeploymentJobSchema) })
        .parse(await this.request("broker-deployments/query", {})).jobs;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable) {
        this.brokerDeploymentRetryAt = now() + 60_000;
        return [];
      }
      throw error;
    }
  }
  async decideBrokerDeployment(
    job: PreviewBrokerDeploymentJob,
    decision: BrokerAction,
  ): Promise<PreviewBrokerDeploymentJob> {
    const result = PreviewBrokerDeploymentJobSchema.parse(
      await this.request("broker-deployments/decision", {
        operation: job.operation,
        id: job.id,
        revision: job.revision,
        planSha256: job.planSha256,
        decision,
      }),
    );
    if (
      result.id !== job.id ||
      result.revision !== job.revision ||
      result.planSha256 !== job.planSha256
    )
      throw new Error("Broker receipt changed. Refresh before another action.");
    return result;
  }
  async listMonitors(): Promise<PreviewMonitorJob[]> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const now = this.ports.now ?? Date.now;
    if (now() < this.monitorRetryAt) return [];
    try {
      return z
        .strictObject({ jobs: z.array(PreviewMonitorJobSchema) })
        .parse(await this.request("monitors/query", {})).jobs;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable) {
        this.monitorRetryAt = now() + 60_000;
        return [];
      }
      throw error;
    }
  }
  async decideMonitor(job: PreviewMonitorJob, decision: MonitorAction): Promise<PreviewMonitorJob> {
    const result = PreviewMonitorJobSchema.parse(
      await this.request("monitors/decision", {
        operation: job.operation,
        id: job.id,
        revision: job.revision,
        planSha256: job.planSha256,
        decision,
      }),
    );
    if (
      result.id !== job.id ||
      result.revision !== job.revision ||
      result.planSha256 !== job.planSha256
    )
      throw new Error("Monitor receipt changed. Refresh before another action.");
    return result;
  }
  async listHelpers(): Promise<NativeHelperJob[]> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const now = this.ports.now ?? Date.now;
    if (now() < this.helperRetryAt) return [];
    try {
      const result = z
        .strictObject({ jobs: z.array(NativeHelperJobSchema) })
        .parse(await this.request("helpers/query", {}));
      return result.jobs;
    } catch (error) {
      // COMPAT(nativeHelperMaintenance): old coordinators have no helper route.
      if (error instanceof InstallationRouteUnavailable) {
        // Keep discovering coordinator upgrades without probing an absent route every five seconds.
        this.helperRetryAt = now() + 60_000;
        return [];
      }
      throw error;
    }
  }

  async decideHelper(job: NativeHelperJob, action: HelperReviewAction): Promise<NativeHelperJob> {
    const identity = { id: job.id, revision: job.revision, planSha256: job.planSha256 };
    const result = NativeHelperJobSchema.parse(
      await this.request(
        action === "verify-installed" ? "helpers/verify-installed" : "helpers/decision",
        action === "verify-installed"
          ? { ...identity, operation: "native-helper-verify-installed" }
          : { ...identity, operation: job.operation, decision: action },
      ),
    );
    if (
      result.id !== job.id ||
      result.revision !== job.revision ||
      result.planSha256 !== job.planSha256
    )
      throw new Error("Helper receipt changed. Refresh status before taking another action.");
    return result;
  }

  /** Null when the coordinator predates instruction requests, so the panel hides its card. */
  async listInstructionRequests(): Promise<InstructionRequestQuery | null> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const now = this.ports.now ?? Date.now;
    if (now() < this.instructionRetryAt) return null;
    try {
      return InstructionRequestQuerySchema.parse(
        await this.request("instruction-requests/query", {}),
      );
    } catch (error) {
      // COMPAT(instructionRequests): older coordinators have no instruction request route.
      if (error instanceof InstallationRouteUnavailable) {
        this.instructionRetryAt = now() + 60_000;
        return null;
      }
      throw error;
    }
  }

  async decideInstructionRequest(
    request: InstructionRequestView,
    decision: "approve" | "reject",
  ): Promise<InstructionRequestView> {
    const result = InstructionRequestQuerySchema.shape.requests.element.parse(
      await this.request("instruction-requests/decision", {
        id: request.id,
        decision,
        proposedSha256: request.proposedSha256,
      }),
    );
    if (result.id !== request.id || result.proposedSha256 !== request.proposedSha256)
      throw new Error("Instruction request changed. Refresh before another action.");
    return result;
  }

  /** Null when the coordinator predates session host jobs, so the panel hides its card. */
  async sessionHost(): Promise<SessionHostOverview | null> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const now = this.ports.now ?? Date.now;
    if (!this.sessionHostSupported && now() < this.sessionHostRetryAt) return null;
    try {
      const overview = SESSION_HOST_OVERVIEW_READER.parse(
        // The flags declare what this interface can parse: restart jobs, the hosted indicator and
        // pending upgrades. Older coordinators ignore them; newer ones withhold those additions
        // from clients without them. From v762 the reader ignores unknown keys, so later additions
        // reach this interface without a flag; the flags remain for older interfaces.
        await this.request("session-host/query", { restart: true, indicator: true, upgrade: true }),
      );
      this.sessionHostSupported = true;
      return overview;
    } catch (error) {
      // COMPAT(sessionHostJob): added in v708, remove after 2027-04-20 once every coordinator
      // serves the session host owner routes. Until then an older coordinator hides the card;
      // one that already answered and then loses the route reports the failure instead.
      if (error instanceof InstallationRouteUnavailable && !this.sessionHostSupported) {
        this.sessionHostRetryAt = now() + 60_000;
        return null;
      }
      throw error;
    }
  }

  async requestSessionHost(
    operation: SessionHostOperation,
    reason: string,
  ): Promise<SessionHostJob> {
    if (!this.sessionHostSupported)
      throw new Error("Session host controls are unavailable. Update the coordinator first.");
    const id = globalThis.crypto.randomUUID();
    const job = SessionHostJobSchema.parse(
      await this.request("session-host/request", { id, operation, reason }),
    );
    if (job.id !== id || job.operation !== operation)
      throw new Error("Session host receipt changed. Refresh before another action.");
    return job;
  }

  async decideSessionHost(
    job: SessionHostJob,
    decision: SessionHostAction,
  ): Promise<SessionHostJob> {
    const result = SessionHostJobSchema.parse(
      await this.request("session-host/decision", {
        operation: job.operation,
        id: job.id,
        revision: job.revision,
        planSha256: job.planSha256,
        decision,
      }),
    );
    if (
      result.id !== job.id ||
      result.operation !== job.operation ||
      result.revision !== job.revision ||
      result.planSha256 !== job.planSha256
    )
      throw new Error("Session host receipt changed. Refresh before another action.");
    return result;
  }

  async devRepairStatus(): Promise<{
    available: boolean;
    preparingIds: string[];
  }> {
    try {
      const result = z
        .strictObject({
          available: z.boolean(),
          preparingIds: z.array(z.string().uuid()),
        })
        .parse(await this.request("dev-repair/query", {}));
      this.devRepairSupported = true;
      this.devRepairAvailable = result.available;
      return result;
    } catch (error) {
      this.devRepairAvailable = false;
      if (error instanceof InstallationRouteUnavailable && !this.devRepairSupported)
        return { available: false, preparingIds: [] };
      throw error;
    }
  }

  async prepareDevRepair(job: RestartJob): Promise<void> {
    if (!this.devRepairAvailable) throw new Error("Update the coordinator to prepare Dev repairs");
    const receipt = z.strictObject({ id: z.string().uuid(), revision: z.string().uuid() }).parse(
      await this.request("dev-repair/prepare", {
        id: job.id,
        revision: job.revision,
      }),
    );
    if (receipt.id !== job.id)
      throw new Error("Dev repair receipt changed. Refresh before another action.");
  }

  async listRestarts(): Promise<RestartJob[]> {
    return z.array(RestartJobSchema).parse(await this.request("restarts/query", {}));
  }

  async decide(job: RestartJob, decision: RestartDecision): Promise<void> {
    if (
      (decision === "approve-when-idle" || decision === "cancel") &&
      !this.installation.idleRestarts
    )
      throw new Error("Update the installation coordinator to support queued idle restarts");
    if (
      ["finish-current-turns", "request-again"].includes(decision) &&
      !this.installation.gracefulRestarts
    )
      throw new Error("Update the coordinator to support this restart action");
    RestartJobSchema.parse(
      await this.request(`restarts/${job.id}/decision`, {
        revision: job.revision,
        decision,
        ...(job.update ? { updateSha256: job.update.sha256 } : {}),
        ...restartPlanBindings(job),
      }),
    );
  }

  async maintenanceStatus(): Promise<InstallationMaintenanceStatus | null> {
    try {
      const status = InstallationMaintenanceStatusSchema.parse(
        await this.request("maintenance-status/query", {}),
      );
      this.maintenanceStatusSupported = true;
      return status;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable && !this.maintenanceStatusSupported)
        return null;
      throw error;
    }
  }

  async maintenanceServices(): Promise<MaintenanceServiceQueueStatus> {
    const status = MaintenanceServiceQueueStatusSchema.parse(
      await this.request("maintenance-services/query", {}),
    );
    if (status.installationId !== this.installation.installationId)
      throw new Error("Maintenance queue belongs to another installation");
    return status;
  }

  async cancelMaintenanceService(job: MaintenanceServiceView): Promise<MaintenanceServiceView> {
    if (!job.cancelable) throw new Error("Maintenance was already dispatched");
    const result = MaintenanceServiceViewSchema.parse(
      await this.request("maintenance-services/cancel", { id: job.id, revision: job.revision }),
    );
    if (result.id !== job.id || result.status !== "rejected" || result.cancelable)
      throw new Error("Maintenance cancellation was not confirmed. Refresh its receipt.");
    return result;
  }

  async recoveryAccess(): Promise<InstallationRecoveryAccessStatus | null> {
    try {
      const status = InstallationRecoveryAccessStatusSchema.parse(
        await this.request("recovery-access/query", {}),
      );
      if (status.installationId !== this.installation.installationId)
        throw new Error("Recovery bookmark belongs to another installation");
      this.recoveryAccessSupported = true;
      return status;
    } catch (error) {
      // COMPAT(recoveryBookmark): added in Vorteo 623; remove when every supported
      // coordinator provides the separate owner recovery-access query.
      if (error instanceof InstallationRouteUnavailable && !this.recoveryAccessSupported)
        return null;
      throw error;
    }
  }

  async enrollmentStatus(): Promise<InstallationEnrollmentStatus | null> {
    try {
      const status = InstallationEnrollmentStatusSchema.parse(
        await this.request("enrollment/query", {}),
      );
      if (status.installationId !== this.installation.installationId)
        throw new Error("Installation status belongs to another installation");
      this.enrollmentStatusSupported = true;
      return status;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable && !this.enrollmentStatusSupported)
        return null;
      throw error;
    }
  }

  private maintenanceDelegationSupported = false;

  async maintenanceDelegation(): Promise<MaintenanceDelegationStatus | null> {
    try {
      const status = MaintenanceDelegationStatusSchema.parse(
        await this.request("maintenance-delegation/query?management=1", {}),
      );
      this.maintenanceDelegationSupported = true;
      return status;
    } catch (error) {
      // COMPAT(fullMaintenanceDelegation): v877; older coordinators retain their service controls.
      if (error instanceof InstallationRouteUnavailable && !this.maintenanceDelegationSupported)
        return null;
      throw error;
    }
  }

  private installationTypeSupported = false;

  /** Null on coordinators without installation types. */
  async installationType(): Promise<InstallationTypeStatus | null> {
    try {
      const status = InstallationTypeStatusSchema.parse(
        await this.request("installation-type/query", {}),
      );
      this.installationTypeSupported = true;
      return status;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable && !this.installationTypeSupported)
        return null;
      throw error;
    }
  }

  async changeInstallationType(
    status: InstallationTypeStatus,
    type: InstallationType,
  ): Promise<InstallationTypeStatus> {
    if (!this.installationTypeSupported)
      throw new InstallationRouteUnavailable("Installation types are unavailable");
    return InstallationTypeStatusSchema.parse(
      await this.request("installation-type/change", { expectedRevision: status.revision, type }),
    );
  }

  private liveDevSupported = false;

  /** Null on coordinators without live dev mode. */
  async liveDev(): Promise<LiveDevStatus | null> {
    try {
      const status = LiveDevStatusSchema.parse(await this.request("live-dev/query", {}));
      this.liveDevSupported = true;
      return status;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable && !this.liveDevSupported) return null;
      throw error;
    }
  }

  async changeLiveDev(status: LiveDevStatus, mode: LiveDevMode): Promise<LiveDevStatus> {
    if (!this.liveDevSupported)
      throw new InstallationRouteUnavailable("Live dev mode is unavailable");
    return LiveDevStatusSchema.parse(
      await this.request("live-dev/change", { expectedRevision: status.revision, mode }),
    );
  }

  private customDomainSupported = false;

  /** Null on coordinators without the custom domain route. */
  async customDomain(): Promise<CustomDomainStatus | null> {
    try {
      const status = CustomDomainStatusSchema.parse(await this.request("custom-domain/query", {}));
      this.customDomainSupported = true;
      return status;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable && !this.customDomainSupported) return null;
      throw error;
    }
  }

  async changeCustomDomain(
    status: CustomDomainStatus,
    origin: string | null,
  ): Promise<CustomDomainStatus> {
    if (!this.customDomainSupported)
      throw new InstallationRouteUnavailable("Custom domain is unavailable");
    return CustomDomainStatusSchema.parse(
      await this.request("custom-domain/change", { expectedRevision: status.revision, origin }),
    );
  }

  async changeMaintenanceDelegation(
    status: MaintenanceDelegationStatus,
    enabled: boolean,
  ): Promise<MaintenanceDelegationStatus> {
    if (!this.maintenanceDelegationSupported || !status.available)
      throw new InstallationRouteUnavailable("Full maintenance delegation is unavailable");
    // Management follows the full grant; there is no separate owner switch to send.
    return MaintenanceDelegationStatusSchema.parse(
      await this.request("maintenance-delegation/change?management=1", {
        expectedRevision: status.revision,
        enabled,
      }),
    );
  }

  async daemonAutomation(): Promise<DaemonAutomationPreference | null> {
    try {
      let response: unknown;
      try {
        response = await this.request("maintenance-permissions/query", {});
        this.servicePermissionsSupported = true;
      } catch (error) {
        if (!(error instanceof InstallationRouteUnavailable) || this.servicePermissionsSupported)
          throw error;
        response = await this.request("daemon-automation/query", {});
      }
      const preference = DaemonAutomationPreferenceSchema.parse(response);
      this.daemonAutomationSupported = true;
      return preference;
    } catch (error) {
      if (error instanceof InstallationRouteUnavailable && !this.daemonAutomationSupported)
        return null;
      throw error;
    }
  }

  async changeDaemonAutomation(
    preference: DaemonAutomationPreference,
    enabled: boolean,
    service?: MaintenanceService,
  ): Promise<DaemonAutomationPreference> {
    if (!this.daemonAutomationSupported)
      throw new InstallationRouteUnavailable("Automatic daemon maintenance is unavailable");
    if (service && !preference.services)
      throw new InstallationRouteUnavailable(
        "Update the coordinator for separate service permissions",
      );
    return DaemonAutomationPreferenceSchema.parse(
      await this.request(service ? "maintenance-permissions/change" : "daemon-automation/change", {
        expectedRevision: preference.revision,
        enabled,
        ...(service ? { service } : {}),
      }),
    );
  }

  async profileSharingStatus(): Promise<ProfileSharingStatus | null> {
    if (this.installation.profileSharing !== true) return null;
    return ProfileSharingStatusSchema.nullable().parse(await this.request("profiles/query", {}));
  }

  async resolveProfileConflict(input: {
    serverId: string;
    expectedRevision: number;
    choice: "shared" | "environment";
  }): Promise<void> {
    ProfileSharingStatusSchema.parse(await this.request("profiles/resolve", input));
  }

  /** Null when the coordinator predates safety snapshots, so the panel hides the card. */
  async snapshots(): Promise<SnapshotList | null> {
    try {
      return SNAPSHOT_LIST_READER.parse(await this.request("snapshots/query", {}));
    } catch (error) {
      // COMPAT(installationUpgrades): older coordinators answer 404 for snapshot routes.
      if (error instanceof InstallationRouteUnavailable) return null;
      throw error;
    }
  }

  async takeSnapshot(): Promise<InstallationSnapshot> {
    return SNAPSHOT_READER.parse(await this.request("snapshots", {}));
  }

  /** `parts` must be exactly the parts the owner confirmed; the coordinator rejects any other set. */
  async restoreSnapshot(
    snapshot: InstallationSnapshot,
    parts: readonly SnapshotPartKind[],
  ): Promise<SnapshotRestoreStatus> {
    const status = SNAPSHOT_RESTORE_READER.parse(
      await this.request("snapshots/restore", { id: snapshot.id, parts: [...parts] }),
    );
    if (status.snapshotId !== snapshot.id)
      throw new Error("Restore receipt names another snapshot. Refresh before another action.");
    return status;
  }

  /** Null when the coordinator predates release upgrades, so the interface keeps its agent task. */
  async upgradeStatus(): Promise<UpgradeStatus | null> {
    try {
      return UPGRADE_STATUS_READER.parse(await this.request("upgrades/query", {}));
    } catch (error) {
      // COMPAT(installationUpgrades): older coordinators answer 404 for upgrade routes.
      if (error instanceof InstallationRouteUnavailable) return null;
      throw error;
    }
  }

  async requestUpgrade(release: ReleaseTag): Promise<InstallationUpgrade> {
    const upgrade = UPGRADE_READER.parse(await this.request("upgrades", { release }));
    if (upgrade.release !== release)
      throw new Error("Upgrade receipt names another release. Refresh before another action.");
    return upgrade;
  }

  async decideUpgrade(
    upgrade: InstallationUpgrade,
    decision: UpgradeDecision["decision"],
  ): Promise<InstallationUpgrade> {
    const result = UPGRADE_READER.parse(
      await this.request(`upgrades/${upgrade.id}/decision`, {
        revision: upgrade.revision,
        decision,
      }),
    );
    if (result.id !== upgrade.id)
      throw new Error("Upgrade receipt changed. Refresh before another action.");
    return result;
  }

  /** Actions Host agents ran at once under the full maintenance grant, newest first. */
  async agentActionReceipts(): Promise<AgentActionReceipt[]> {
    try {
      return AGENT_ACTIONS_READER.parse(await this.request("agent-actions/query", {})).receipts;
    } catch (error) {
      // COMPAT(agentActions): older coordinators answer 404; they ran no immediate agent actions.
      if (error instanceof InstallationRouteUnavailable) return [];
      throw error;
    }
  }

  /** Null on coordinators without Stable source upgrades, so the card hides. */
  async sourceUpgradeStatus(): Promise<SourceUpgradeStatus | null> {
    try {
      return SOURCE_UPGRADE_STATUS_READER.parse(await this.request("source-upgrades/query", {}));
    } catch (error) {
      // COMPAT(sourceUpgrades): older coordinators answer 404 for these routes.
      if (error instanceof InstallationRouteUnavailable) return null;
      throw error;
    }
  }

  /** Decides the exact revision shown, so a changed request must be reviewed again. */
  async decideSourceUpgrade(
    upgrade: SourceUpgrade,
    decision: SourceUpgradeDecision["decision"],
  ): Promise<SourceUpgrade> {
    const result = SOURCE_UPGRADE_READER.parse(
      await this.request(`source-upgrades/${upgrade.id}/decision`, {
        revision: upgrade.revision,
        decision,
      }),
    );
    if (result.id !== upgrade.id)
      throw new Error("Source upgrade receipt changed. Refresh before another action.");
    return result;
  }

  /** Installation changes Host agents requested; empty on coordinators without them. */
  async installationChanges(): Promise<QueuedAgentAction[]> {
    try {
      return INSTALLATION_CHANGES_READER.parse(await this.request("queued-actions/query", {})).jobs;
    } catch (error) {
      // COMPAT(installationChanges): older coordinators answer 404 and hold no such requests.
      if (error instanceof InstallationRouteUnavailable) return [];
      throw error;
    }
  }

  async decideInstallationChange(
    job: QueuedAgentAction,
    decision: "approve" | "cancel",
  ): Promise<QueuedAgentAction> {
    const result = INSTALLATION_CHANGE_READER.parse(
      await this.request(`queued-actions/${job.id}/decision`, { revision: job.revision, decision }),
    );
    if (result.id !== job.id)
      throw new Error("Installation change receipt changed. Refresh before another action.");
    return result;
  }

  /** Null when the coordinator cannot move itself onto the Host release, so the card hides. */
  async coordinatorFollowStatus(): Promise<CoordinatorFollowStatus | null> {
    try {
      return COORDINATOR_FOLLOW_STATUS_READER.parse(
        await this.request("coordinator-follow/query", {}),
      );
    } catch (error) {
      // COMPAT(coordinatorFollow): older coordinators answer 404 for these routes.
      if (error instanceof InstallationRouteUnavailable) return null;
      throw error;
    }
  }

  /** Creates the update for the reviewed Host release, then approves it. */
  async updateCoordinator(next: string): Promise<CoordinatorFollowJob> {
    const job = COORDINATOR_FOLLOW_READER.parse(await this.request("coordinator-follow", { next }));
    if (job.next !== next)
      throw new Error("Coordinator update names another release. Refresh before another action.");
    return this.decideCoordinatorFollow(job, "approve");
  }

  async decideCoordinatorFollow(
    job: CoordinatorFollowJob,
    decision: CoordinatorFollowDecision["decision"],
  ): Promise<CoordinatorFollowJob> {
    const result = COORDINATOR_FOLLOW_READER.parse(
      await this.request(`coordinator-follow/${job.id}/decision`, {
        revision: job.revision,
        decision,
      }),
    );
    if (result.id !== job.id)
      throw new Error("Coordinator update receipt changed. Refresh before another action.");
    return result;
  }

  /** Null when the coordinator predates settings changes, so the card hides. */
  async coordinatorSettingsStatus(): Promise<CoordinatorSettingsStatus | null> {
    try {
      return COORDINATOR_SETTINGS_STATUS_READER.parse(
        await this.request("coordinator-settings/query", {}),
      );
    } catch (error) {
      // COMPAT(coordinatorSettings): older coordinators answer 404 for these routes.
      if (error instanceof InstallationRouteUnavailable) return null;
      throw error;
    }
  }

  /**
   * Approves, rejects or cancels a settings change. With `follow`, one approval covers that
   * coordinator update and these settings; a release string first creates the update for it.
   */
  async decideCoordinatorSettings(
    job: CoordinatorSettingsJob,
    decision: CoordinatorSettingsDecision["decision"],
    follow?: CoordinatorFollowJob | string,
  ): Promise<CoordinatorSettingsJob> {
    let followJob = typeof follow === "string" ? undefined : follow;
    if (typeof follow === "string") {
      followJob = COORDINATOR_FOLLOW_READER.parse(
        await this.request("coordinator-follow", { next: follow }),
      );
      if (followJob.next !== follow)
        throw new Error("Coordinator update names another release. Refresh before another action.");
    }
    const result = COORDINATOR_SETTINGS_READER.parse(
      await this.request(`coordinator-settings/${job.id}/decision`, {
        revision: job.revision,
        decision,
        ...(followJob ? { follow: { id: followJob.id, revision: followJob.revision } } : {}),
        // COMPAT(coordinatorSettingFields): added in 26.11.6, remove after 2027-05-07 once every coordinator accepts reviewedFields.
        ...(job.changes.some((change) => change.fields !== undefined)
          ? { reviewedFields: true as const }
          : {}),
      }),
    );
    if (result.id !== job.id)
      throw new Error("Coordinator settings receipt changed. Refresh before another action.");
    return result;
  }

  /** Saves the update policy and re-checks. Call only when the status reports `policy`. */
  async changeUpdatePolicy(change: UpdatePolicyChange): Promise<UpgradeStatus> {
    return UPGRADE_STATUS_READER.parse(await this.request("update-policy", change));
  }

  /** Checks the installation's channel now. Call only when the status reports `policy`. */
  async checkForUpdates(): Promise<UpgradeStatus> {
    return UPGRADE_STATUS_READER.parse(await this.request("update-check", {}));
  }

  private request(path: string, body: unknown): Promise<unknown> {
    if (this.password === null) throw new Error("Unlock installation controls first");
    const resource =
      this.installation.idleRestarts && path.startsWith("restarts")
        ? `${path}?idleRestarts=1${this.installation.gracefulRestarts ? "&gracefulRestarts=1" : ""}`
        : path;
    const query = path.startsWith("restarts")
      ? `${resource}${resource.includes("?") ? "&" : "?"}sourceUpdates=1&sourceBatches=1&containerSourceUpdates=1&supervisorMaintenance=1&hostAutomaticRestarts=1&factoryRuntimeAdoption=1&engineRestart=1&engineRecovery=1&hostLauncherUpdate=1&bootEntrySwitch=1&delegatedRequests=1`
      : resource;
    return this.ports.request(query, this.password, body);
  }
}

export async function requestInstallationOwner(
  path: string,
  password: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(`/api/installation/owner/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(password ? { Authorization: `Bearer ${password}` } : {}),
    },
    body: JSON.stringify(body),
    redirect: "error",
    cache: "no-store",
  });
  // Older coordinators may serve their SPA fallback for an unknown owner query.
  // A client that already observed support still treats this as a lost capability.
  if (
    [
      "daemon-automation/query",
      "dev-repair/query",
      "session-host/query",
      "instruction-requests/query",
      "snapshots/query",
      "upgrades/query",
      "coordinator-follow/query",
      "coordinator-settings/query",
      "claude/oauth/read",
      "claude/oauth/upgrade/read",
    ].includes(path) &&
    response.ok &&
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    throw new InstallationRouteUnavailable("Installation maintenance operation is unavailable");
  }
  if (response.status === 401)
    throw path === "unlock"
      ? new Error("Incorrect owner password. Use the password generated by the host installer.")
      : new OwnerAccessExpired("Owner access expired or was locked. Unlock controls to continue.");
  if (response.status === 404)
    throw new InstallationRouteUnavailable("Installation operation is unavailable");
  if (!response.ok) {
    const detail = z
      .object({ error: z.string().max(2000) })
      .safeParse(await response.json().catch(() => null));
    throw new InstallationRequestFailed(
      detail.success ? detail.data.error : `Installation request failed (${response.status})`,
      response.status,
    );
  }
  return response.json();
}
