import type {
  ExecutionInstallation,
  RestartDecision,
  RestartJob,
} from "@getpaseo/protocol/execution-installation";
import type {
  UpgradeStatus,
  UpgradeDecision,
  InstallationUpgrade,
} from "@getpaseo/protocol/installation-upgrades";
import {
  upgradeApprovalText,
  supportsUpdatePolicy,
} from "@/execution-installation/installation-upgrades-model";
import {
  supervisorRepairNeedsImmediateApproval,
  restartActionDisabledReason,
} from "@/execution-installation/panel-model";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";
import type { InstallationSystemState, SystemTarget } from "./system-adapter-model";
import type { SystemAction } from "./system-status-model";
export interface SystemActionContext {
  serverId: string;
  target: SystemTarget;
  installation: ExecutionInstallation | null;
  state: InstallationSystemState | null;
  upgrades: readonly InstallationUpgrade[];
  offer: string | null;
  upgradeStatus?: UpgradeStatus | null;
}
export interface SystemActionPorts {
  confirm(input: ConfirmDialogInput): Promise<boolean>;
  reconnect(serverId: string): Promise<void>;
  restart(job: RestartJob, decision: RestartDecision): Promise<void>;
  upgrade(upgrade: InstallationUpgrade, decision: UpgradeDecision["decision"]): Promise<unknown>;
  requestUpgrade(release: string): Promise<unknown>;
  updateStandalone(serverId: string): Promise<void>;
}
async function approveRestart(
  context: SystemActionContext,
  id: string | undefined,
  ports: SystemActionPorts,
) {
  const { state, installation, target } = context;
  const job = state?.pendingJobs.find((entry) => entry.id === id && entry.target === target);
  if (!state?.unlocked || !job)
    throw new Error("This request changed. Refresh System and review it again.");
  const recovering = Boolean(
    job.engineRecoveryPlanSha256 || supervisorRepairNeedsImmediateApproval(job),
  );
  const installing = Boolean(job.update || job.sourceBatch || recovering);
  let blocker: string | null;
  if (recovering) blocker = state.busy ? "Another action is in progress" : null;
  else
    blocker = restartActionDisabledReason(
      job,
      installing ? "install" : "finish",
      state.busy,
      Boolean(installation?.gracefulRestarts && job.impact?.gracefulRestartSupported),
    );
  if (blocker) throw new Error(blocker);
  const message = installing
    ? "Reviewed code will be installed and running work may be interrupted."
    : "Current turns finish before the restart. New work waits.";
  if (
    await ports.confirm({
      title: "Approve restart",
      message: `${job.reason}\n\n${message}`,
      confirmLabel: "Approve restart",
      destructive: installing,
    })
  )
    await ports.restart(job, installing ? "approve" : "finish-current-turns");
}
async function approveUpgrade(
  context: SystemActionContext,
  id: string | undefined,
  ports: SystemActionPorts,
) {
  const upgrade = context.upgrades.find((entry) => entry.id === id);
  if (!context.state?.unlocked || !upgrade || upgrade.status !== "pending")
    throw new Error("Reconnect and unlock System controls to review this update.");
  const afterWork = supportsUpdatePolicy(context.upgradeStatus);
  if (
    await ports.confirm({
      title: "Approve update?",
      message: upgradeApprovalText(
        context.upgradeStatus?.container ?? true,
        afterWork,
        context.upgradeStatus?.upgrades,
      ),
      confirmLabel: "Approve update",
      destructive: true,
    })
  )
    await ports.upgrade(upgrade, afterWork ? "approve-after-work" : "approve");
}
/** Confirmation and reviewed revisions remain mandatory even when the row offers a shortcut. */
export async function executeSystemAction(
  context: SystemActionContext,
  action: SystemAction,
  ports: SystemActionPorts,
): Promise<void> {
  if (action.kind === "reconnect") {
    await ports.reconnect(context.serverId);
    return;
  }
  if (action.kind === "approve-restart") {
    await approveRestart(context, action.id, ports);
    return;
  }
  if (action.kind === "approve-upgrade") {
    await approveUpgrade(context, action.id, ports);
    return;
  }
  if (context.installation) {
    if (!context.state?.unlocked || !context.offer)
      throw new Error("Unlock System controls to prepare this update.");
    await ports.requestUpgrade(context.offer);
    return;
  }
  if (
    await ports.confirm({
      title: "Update Host?",
      message: "The Host restarts after the update. Review its running work before continuing.",
      confirmLabel: "Update Host",
    })
  )
    await ports.updateStandalone(context.serverId);
}
