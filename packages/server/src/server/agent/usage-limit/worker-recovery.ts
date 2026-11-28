import { isDeepStrictEqual } from "node:util";
import {
  getParentAgentIdFromLabels,
  PARENT_SERVER_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { AgentStorage, StoredAgentRecord } from "../agent-storage.js";
import { ProfileSwitchError } from "../agent-manager.js";
import {
  type ProfileSwitchDependencies,
  type ProfileSwitchOptions,
  type ProfileSwitchTarget,
} from "../profile-switch/command.js";
import type { AgentProfileSwitchResult } from "@getpaseo/protocol/messages";

interface RecoveryInput {
  agentId: string;
  supervisorId: string;
  serverId: string | undefined;
  inScope: (cwd: string) => boolean;
}

type WorkerUsageRecovery =
  | { outcome: "reopened"; provider: string; reason: string; droppedLowProviders?: string[] }
  | { outcome: "waiting"; reason: string; earliestResetAt: string | null }
  | { outcome: "refused"; reason: string; error?: string };

interface RecoveryDependencies extends Pick<
  ProfileSwitchDependencies,
  "getSharedProviderConfig" | "pickTeamWorkerAccount"
> {
  agentStorage: Pick<AgentStorage, "get">;
  switchProfile(
    target: ProfileSwitchTarget,
    options: ProfileSwitchOptions & { includeResult: true },
  ): Promise<AgentProfileSwitchResult>;
}

/** Reopens the same supervised thread using the existing saved-history account switch. */
export async function reopenWorkerAfterUsageLimit(
  dependencies: RecoveryDependencies,
  input: RecoveryInput,
): Promise<WorkerUsageRecovery> {
  const pickAccount = dependencies.pickTeamWorkerAccount;
  if (!pickAccount) return { outcome: "refused", reason: "quota-picker-unavailable" };
  const checked = await authorizedWorker(dependencies.agentStorage, input);
  if (!checked) return { outcome: "refused", reason: "not-supervised-worker" };
  const { teamProfile, supervisor, record } = checked;
  const hold = record.config?.usageLimitHold;
  if (!hold || hold.releasedAt) return { outcome: "refused", reason: "no-usage-stop" };
  if (hold.optOut) return { outcome: "refused", reason: "owner-opted-out" };
  const settings = dependencies.getSharedProviderConfig?.();
  const pick = await pickAccount({
    worker: teamProfile,
    supervisorProvider: supervisor.provider,
    avoidProvider: record.provider,
    settings,
  });
  if (!pick.provider) {
    const resets = [pick.earliestResetAt, hold.resetsAt]
      .map((value) => Date.parse(value ?? ""))
      .filter((value) => value > Date.now());
    const earliestResetAt = resets.length ? new Date(Math.min(...resets)).toISOString() : null;
    return { outcome: "waiting", reason: pick.reason, earliestResetAt };
  }
  const provider = pick.provider;
  const { droppedLowProviders } = pick;
  const sourceProfile = record.config?.profileLaunch?.profile;
  if (!sourceProfile || provider === record.provider)
    return { outcome: "refused", reason: "invalid-recovery-target" };
  const result = await dependencies.switchProfile(
    {
      agentId: record.id,
      provider,
      profileId: sourceProfile.id,
      reason: "quota",
      explanation: recoveryExplanation(pick.reason, droppedLowProviders),
    },
    {
      includeResult: true,
      actor: { kind: "agent", id: input.supervisorId },
      workerRecovery: true,
      validateScope: async (source) => {
        const current = await authorizedWorker(dependencies.agentStorage, input);
        const sameSource = isDeepStrictEqual(source, {
          provider: record.provider,
          cwd: record.cwd,
          workspaceId: record.workspaceId,
        });
        const sameAuthority = isDeepStrictEqual(current && authoritySnapshot(current), {
          supervisorProvider: supervisor.provider,
          teamProfile,
          sourceProfile,
          hold,
        });
        if (
          !sameSource ||
          !sameAuthority ||
          dependencies.getSharedProviderConfig?.() !== settings
        ) {
          throw new ProfileSwitchError(
            "The worker, usage stop, or account settings changed. Check the worker and try again.",
            "source-changed",
          );
        }
      },
    },
  );
  return result.outcome === "switched"
    ? {
        outcome: "reopened",
        provider,
        reason: pick.reason,
        ...(droppedLowProviders ? { droppedLowProviders } : {}),
      }
    : { outcome: "refused", reason: result.refusalCode ?? "switch-refused", error: result.error };
}

function recoveryExplanation(reason: string, droppedLowProviders: string[] | undefined): string {
  let selection = "Recovery used an eligible account with measured quota.";
  if (reason === "default-usage-unreadable")
    selection = "Recovery used the preset's default account because its quota was unreadable.";
  if (reason === "alternate-usage-unreadable")
    selection = "Recovery used the first eligible alternate account with unreadable quota.";
  const dropped = droppedLowProviders?.length
    ? ` Skipped accounts at or below the quota floor: ${droppedLowProviders.join(", ")}.`
    : "";
  return `The worker stopped at a usage limit. ${selection}${dropped}`;
}

interface SupervisedWorker {
  supervisor: StoredAgentRecord;
  record: StoredAgentRecord;
  teamProfile: AgentProfile;
}

async function authorizedWorker(
  storage: Pick<AgentStorage, "get">,
  input: RecoveryInput,
): Promise<SupervisedWorker | null> {
  const [supervisor, record] = await Promise.all([
    storage.get(input.supervisorId),
    storage.get(input.agentId),
  ]);
  if (!supervisor || supervisor.archivedAt || !record || record.archivedAt) return null;
  if (record.id === supervisor.id || !input.inScope(record.cwd)) return null;
  if (record.owner || record.internal || record.config?.controllerExecutionId) return null;
  const workerId = record.config?.profileLaunch?.profile.id;
  if (!matchesWorkerGovernance(record, input, workerId)) return null;
  const teamProfile = supervisor.config?.profileLaunch?.workers?.find(({ id }) => id === workerId);
  return teamProfile ? { supervisor, record, teamProfile } : null;
}

function matchesWorkerGovernance(
  record: StoredAgentRecord,
  input: RecoveryInput,
  workerId: string | undefined,
): boolean {
  const governance = record.workerGovernance;
  const parentServerId = record.labels[PARENT_SERVER_ID_LABEL];
  return Boolean(
    governance &&
    governance.supervisorAgentId === input.supervisorId &&
    governance.serverId === input.serverId &&
    governance.workerProfileId === workerId &&
    getParentAgentIdFromLabels(record.labels) === input.supervisorId &&
    (!parentServerId || parentServerId === input.serverId),
  );
}

function authoritySnapshot({ supervisor, teamProfile, record }: SupervisedWorker) {
  return {
    supervisorProvider: supervisor.provider,
    teamProfile,
    sourceProfile: record.config?.profileLaunch?.profile,
    hold: record.config?.usageLimitHold,
  };
}
