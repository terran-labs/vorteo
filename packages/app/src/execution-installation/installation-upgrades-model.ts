import {
  SNAPSHOT_PART_LABELS,
  UPGRADE_STEP_LABELS,
  type InstallationSnapshot,
  type InstallationUpgrade,
  type ReleaseNotes,
  type SnapshotList,
  type SnapshotPartKind,
  type UpgradeDecision,
  type UpgradeStatus,
} from "@getpaseo/protocol/installation-upgrades";

// Pure views of safety snapshots and release upgrades for Installation controls and the
// update section. The coordinator owns every decision; these only describe its replies.

export function snapshotReasonLabel(snapshot: InstallationSnapshot): string {
  if (snapshot.reason === "upgrade")
    return snapshot.release ? `Before upgrade to ${snapshot.release}` : "Before upgrade";
  if (snapshot.reason === "restore") return "Before restore";
  return "Taken by owner";
}

export function snapshotPartsSummary(snapshot: InstallationSnapshot): string {
  return snapshot.parts.map((part) => SNAPSHOT_PART_LABELS[part.kind]).join(", ");
}

/** Newest first. Snapshot ids sort by creation time, so ties keep a stable order. */
export function sortedSnapshots(list: SnapshotList): InstallationSnapshot[] {
  return list.snapshots.toSorted((left, right) => right.id.localeCompare(left.id));
}

export interface SnapshotRestorePlan {
  /** Exactly the parts the confirmation names, sent back as the restore request. */
  parts: SnapshotPartKind[];
  title: string;
  message: string;
}

export function snapshotRestorePlan(
  snapshot: InstallationSnapshot,
  hasDev: boolean,
  formatTime: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): SnapshotRestorePlan {
  const replaced = snapshot.parts
    .map((part) => `${SNAPSHOT_PART_LABELS[part.kind]}: ${part.source}`)
    .join("\n");
  const services = hasDev
    ? "the coordinator, the Host daemon and the Dev container"
    : "the coordinator and the Host daemon";
  const agents = hasDev ? "Running agents on the Host and in Dev" : "Running agents on the Host";
  return {
    parts: snapshot.parts.map((part) => part.kind),
    title: `Restore the snapshot from ${formatTime(snapshot.createdAt)}?`,
    message: `This replaces:\n${replaced}\n\nVorteo stops ${services}, replaces these parts, then starts them again. ${agents} are interrupted, and this interface disconnects for a minute or two.`,
  };
}

export type RestoreProgress = "waiting" | "reload" | "failed";

/**
 * Where a restore this interface started stands. The coordinator restarts during a restore,
 * so failed queries are expected; once it answers again without a running restore, reload.
 */
export function restoreProgress(
  list: SnapshotList | null | undefined,
  restoreId: string,
  coordinatorWasUnreachable: boolean,
): RestoreProgress {
  const restore = list?.restore;
  if (restore?.id === restoreId) {
    if (restore.status === "succeeded") return "reload";
    if (restore.status === "failed") return "failed";
    return "waiting";
  }
  return list && coordinatorWasUnreachable && restore?.status !== "running" ? "reload" : "waiting";
}

const ACTIVE_UPGRADE_STATUSES = new Set<InstallationUpgrade["status"]>([
  "pending",
  "approved",
  "running",
]);

export function upgradeIsActive(upgrade: InstallationUpgrade): boolean {
  return ACTIVE_UPGRADE_STATUSES.has(upgrade.status);
}

function newestUpgrades(status: UpgradeStatus): InstallationUpgrade[] {
  return status.upgrades.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** The upgrade waiting for approval or in progress. The coordinator runs one at a time. */
export function activeUpgrade(
  status: UpgradeStatus | null | undefined,
): InstallationUpgrade | null {
  if (!status) return null;
  return newestUpgrades(status).find(upgradeIsActive) ?? null;
}

/** The newest upgrade that ended, shown until another one starts. */
export function latestFinishedUpgrade(
  status: UpgradeStatus | null | undefined,
): InstallationUpgrade | null {
  if (!status) return null;
  return newestUpgrades(status).find((upgrade) => !upgradeIsActive(upgrade)) ?? null;
}

/** The coordinator reports an update policy, so it accepts the policy routes and decisions. */
export function supportsUpdatePolicy(status: UpgradeStatus | null | undefined): boolean {
  return status?.policy !== undefined;
}

/**
 * The release to offer, or null. Offers need a coordinator that supports upgrades, a newer
 * published release and no upgrade already waiting or running. A coordinator with an update
 * policy checks its own channel, so its check replaces the app's stable-only GitHub check.
 */
export function upgradeOffer(input: {
  status: UpgradeStatus | null | undefined;
  latestRelease: string | undefined;
  updateAvailable: boolean;
}): string | null {
  const { status } = input;
  if (!status?.available) return null;
  const appRelease = input.updateAvailable ? input.latestRelease : undefined;
  const latestRelease = supportsUpdatePolicy(status) ? status.check?.latest?.release : appRelease;
  if (!latestRelease) return null;
  if (status.current?.release === latestRelease) return null;
  if (activeUpgrade(status)) return null;
  return latestRelease;
}

/** What approval does. `whenIdle` describes the path that waits for agents to finish. */
export function upgradeApprovalText(hasDev: boolean, whenIdle = false): string {
  const replaces = hasDev
    ? "restarts the Host daemon, replaces the installation coordinator and recreates the Dev container"
    : "restarts the Host daemon and replaces the installation coordinator";
  const agents = whenIdle
    ? "Install after current work holds new work and waits for running turns and Dev agents to finish."
    : "Running agents are interrupted.";
  return `Approval takes a safety snapshot, then ${replaces}. ${agents}`;
}

/** Decisions to offer for a pending upgrade, primary first. Older coordinators only approve now. */
export function pendingUpgradeDecisions(
  status: UpgradeStatus | null | undefined,
): UpgradeDecision["decision"][] {
  return supportsUpdatePolicy(status)
    ? ["approve-after-work", "approve", "reject"]
    : ["approve", "reject"];
}

/**
 * What the owner can decide on an upgrade. Pending ones offer the install choices; one waiting
 * for current work offers Install now, which ends the wait on coordinators with update policies.
 */
export function upgradeDecisions(
  status: UpgradeStatus | null | undefined,
  upgrade: InstallationUpgrade,
): UpgradeDecision["decision"][] {
  if (upgrade.status === "pending") return pendingUpgradeDecisions(status);
  const waiting =
    (upgrade.status === "approved" || upgrade.status === "running") &&
    upgrade.restart === "after-work";
  return waiting && supportsUpdatePolicy(status) ? ["approve"] : [];
}

/** "release-26.10.3001-beta" reads as "26.10.3001 beta". */
export function releaseVersionLabel(release: string): string {
  return release.replace(/^release-/, "").replace(/-beta$/, " beta");
}

/**
 * The installation update the owner should see beside open questions: a pending upgrade to
 * decide, an automatic upgrade that finished and was not dismissed, or one in progress.
 * Questions and notices wait for the owner; progress is shown without counting.
 */
export type InstallationUpdateEntry =
  | { kind: "question"; upgrade: InstallationUpgrade }
  | { kind: "notice"; upgrade: InstallationUpgrade }
  | { kind: "progress"; upgrade: InstallationUpgrade };

export function installationUpdateEntry(
  status: UpgradeStatus | null | undefined,
): InstallationUpdateEntry | null {
  if (!status?.available) return null;
  const active = activeUpgrade(status);
  if (active?.status === "pending") return { kind: "question", upgrade: active };
  if (active) return { kind: "progress", upgrade: active };
  // Acknowledging needs the policy routes; older coordinators never upgrade automatically.
  if (!supportsUpdatePolicy(status)) return null;
  const finished = latestFinishedUpgrade(status);
  if (
    finished?.automatic &&
    (finished.status === "succeeded" || finished.status === "failed") &&
    !finished.acknowledgedAt
  )
    return { kind: "notice", upgrade: finished };
  return null;
}

/** The upgrade's own notes, or the update check's notes for the same release. */
export function upgradeNotes(
  status: UpgradeStatus | null | undefined,
  upgrade: InstallationUpgrade,
): ReleaseNotes | null {
  if (upgrade.notes) return upgrade.notes;
  const latest = status?.check?.latest;
  return latest?.release === upgrade.release ? latest.notes : null;
}

/** Why a finished upgrade failed: its own detail, or the step that failed. */
export function upgradeFailureDetail(upgrade: InstallationUpgrade): string {
  if (upgrade.detail) return upgrade.detail;
  const step = upgrade.steps.find((entry) => entry.status === "failed");
  if (!step) return "No detail was reported.";
  const label = UPGRADE_STEP_LABELS[step.name];
  return step.detail ? `${label}: ${step.detail}` : `${label} failed.`;
}

export function installationUpdateNeedsOwner(entry: InstallationUpdateEntry | null): boolean {
  return entry?.kind === "question" || entry?.kind === "notice";
}

const UPGRADE_STATUS_LABELS: Record<InstallationUpgrade["status"], string> = {
  pending: "Waiting for approval",
  approved: "Approved",
  running: "Upgrading",
  succeeded: "Upgraded",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export function upgradeStatusLabel(upgrade: InstallationUpgrade): string {
  return UPGRADE_STATUS_LABELS[upgrade.status];
}

export interface UpgradeStepRow {
  name: InstallationUpgrade["steps"][number]["name"];
  label: string;
  status: InstallationUpgrade["steps"][number]["status"];
  detail: string;
}

export function upgradeStepRows(upgrade: InstallationUpgrade): UpgradeStepRow[] {
  return upgrade.steps.map((step) => ({
    name: step.name,
    label: UPGRADE_STEP_LABELS[step.name],
    status: step.status,
    detail: step.detail,
  }));
}
