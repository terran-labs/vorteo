import { z } from "zod";

// Owner-only installation upgrades and safety snapshots, served under
// /api/installation/owner/. Older coordinators return 404 for these routes.

/**
 * Releases are the tags `scripts/vorteo-release.mjs` creates: `release-<version>` for stable
 * and `release-<version>-beta` for beta, where the version is a calendar version YY.M.DDNN
 * without leading zeros. See docs/release.md#vorteo-releases.
 */
export const ReleaseTagSchema = z
  .string()
  .regex(
    /^release-[1-9]\d+\.(?:[1-9]|1[0-2])\.[1-9]\d{2,3}(?:-beta)?$/,
    "Release tags look like release-26.10.3001 or release-26.10.3001-beta",
  );
export type ReleaseTag = z.infer<typeof ReleaseTagSchema>;

const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/);

/** What a snapshot captured. Each part is restored as a whole. */
export const SnapshotPartKindSchema = z.enum([
  "coordinator-state",
  "host-home",
  "dev-home",
  "deployment",
]);
export type SnapshotPartKind = z.infer<typeof SnapshotPartKindSchema>;

export const SNAPSHOT_PART_LABELS: Record<SnapshotPartKind, string> = {
  "coordinator-state": "Installation coordinator state",
  "host-home": "Host daemon home",
  "dev-home": "Dev container home",
  deployment: "Deployment files",
};

export const SnapshotPartSchema = z.object({
  kind: SnapshotPartKindSchema,
  /** Where the part came from: an absolute path, or `docker:<container>:<path>`. */
  source: z.string().min(1),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type SnapshotPart = z.infer<typeof SnapshotPartSchema>;

/** The manifest written beside every snapshot as `manifest.json`. */
export const InstallationSnapshotSchema = z.object({
  version: z.literal(1),
  /** Directory name under the snapshot root, derived from the creation time. */
  id: z.string().regex(/^\d{8}T\d{6}(?:\d{3})?Z(?:-\d+)?$/),
  createdAt: z.string().datetime(),
  reason: z.enum(["upgrade", "owner", "restore"]),
  upgradeId: z.string().uuid().optional(),
  release: ReleaseTagSchema.optional(),
  parts: z.array(SnapshotPartSchema),
});
export type InstallationSnapshot = z.infer<typeof InstallationSnapshotSchema>;

export const SnapshotRestoreStatusSchema = z.object({
  id: z.string().uuid(),
  snapshotId: InstallationSnapshotSchema.shape.id,
  status: z.enum(["running", "succeeded", "failed"]),
  /** The step now running, or the last step reached. */
  step: z.string(),
  detail: z.string(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SnapshotRestoreStatus = z.infer<typeof SnapshotRestoreStatusSchema>;

/** Reply to POST /api/installation/owner/snapshots/query. */
export const SnapshotListSchema = z.object({
  available: z.boolean(),
  /** Why snapshots are unavailable, or where they are kept. */
  detail: z.string(),
  retention: z.number().int().positive(),
  snapshots: z.array(InstallationSnapshotSchema),
  restore: SnapshotRestoreStatusSchema.nullable(),
});
export type SnapshotList = z.infer<typeof SnapshotListSchema>;

/**
 * POST /api/installation/owner/snapshots/restore. `parts` must repeat exactly the
 * part kinds the confirmation named, so a changed snapshot cannot be restored blind.
 */
export const SnapshotRestoreRequestSchema = z.strictObject({
  id: InstallationSnapshotSchema.shape.id,
  parts: z.array(SnapshotPartKindSchema).min(1),
});
export type SnapshotRestoreRequest = z.infer<typeof SnapshotRestoreRequestSchema>;

export const UpgradeStepNameSchema = z.enum(["snapshot", "fetch", "host", "coordinator", "dev"]);
export type UpgradeStepName = z.infer<typeof UpgradeStepNameSchema>;

export const UPGRADE_STEP_LABELS: Record<UpgradeStepName, string> = {
  snapshot: "Take a safety snapshot",
  fetch: "Fetch the release",
  host: "Build the release and restart the Host daemon",
  coordinator: "Replace the installation coordinator",
  dev: "Rebuild and recreate the Dev container",
};

export const UpgradeStepSchema = z.object({
  name: UpgradeStepNameSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped", "rolled-back"]),
  detail: z.string(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});
export type UpgradeStep = z.infer<typeof UpgradeStepSchema>;

/** How an installation takes new releases. Manual asks the owner; automatic installs when idle. */
export const UpdateModeSchema = z.enum(["manual", "automatic"]);
export type UpdateMode = z.infer<typeof UpdateModeSchema>;

/** Which releases an installation follows. Beta includes stable releases. */
export const UpdateChannelSchema = z.enum(["stable", "beta"]);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export const UpdatePolicySchema = z.object({
  mode: UpdateModeSchema,
  channel: UpdateChannelSchema,
});
export type UpdatePolicy = z.infer<typeof UpdatePolicySchema>;

export const DEFAULT_UPDATE_POLICY: UpdatePolicy = { mode: "manual", channel: "stable" };

/** POST /api/installation/owner/update-policy. Omitted fields keep their value. */
export const UpdatePolicyChangeSchema = z.strictObject({
  mode: UpdateModeSchema.optional(),
  channel: UpdateChannelSchema.optional(),
});
export type UpdatePolicyChange = z.infer<typeof UpdatePolicyChangeSchema>;

/**
 * What the release notes say about a release, read from its GitHub Release. Security and
 * charter sections follow docs/release.md#public-release-summaries.
 */
export const ReleaseNotesSchema = z.object({
  /** Plain text, at most a few sentences. Empty when the release has no notes. */
  summary: z.string(),
  /** The notes carry a Security section. Security fixes are shown more prominently. */
  security: z.boolean(),
  /** Items of the notes' "Factory charter changes" section. */
  charterChanges: z.array(z.string()),
  url: z.string().url(),
  publishedAt: z.string().datetime().optional(),
});
export type ReleaseNotes = z.infer<typeof ReleaseNotesSchema>;

/** The newest release on the installation's channel, as the coordinator's update check saw it. */
export const UpdateCheckSchema = z.object({
  checkedAt: z.string().datetime().nullable(),
  /** Why the last check failed, or null. */
  error: z.string().nullable(),
  /** The installed Host source version, such as 26.10.3001, or null when unknown. */
  installedVersion: z.string().nullable(),
  /** The newest installable release above the installed version, or null when current. */
  latest: z
    .object({ release: ReleaseTagSchema, channel: UpdateChannelSchema, notes: ReleaseNotesSchema })
    .nullable(),
});
export type UpdateCheck = z.infer<typeof UpdateCheckSchema>;

export const InstallationUpgradeSchema = z.object({
  id: z.string().uuid(),
  /** Changes on every transition; decisions must name the revision they reviewed. */
  revision: z.string().uuid(),
  release: ReleaseTagSchema,
  /** The commit the tag named when the owner reviewed it. Fetching must match it. */
  sourceCommit: CommitSchema,
  /** The installed Host source when the upgrade was requested. */
  previousCommit: CommitSchema.nullable(),
  createdAt: z.string().datetime(),
  status: z.enum([
    "pending",
    "approved",
    "running",
    "succeeded",
    "failed",
    "rejected",
    "cancelled",
  ]),
  detail: z.string(),
  approvedAt: z.string().datetime().optional(),
  snapshotId: InstallationSnapshotSchema.shape.id.optional(),
  steps: z.array(UpgradeStepSchema),
  /** Who asked: the owner from Settings, or the coordinator's update check. Absent means owner. */
  origin: z.enum(["owner", "update-check"]).optional(),
  /** The release notes the update check read when it offered this release. */
  notes: ReleaseNotesSchema.optional(),
  /** Approved by the installation's automatic update policy rather than by the owner. */
  automatic: z.boolean().optional(),
  /**
   * When daemons restart. `after-work` holds new Host work and waits for current turns, and
   * waits for Dev agents to stop before recreating Dev. Absent means now.
   */
  restart: z.enum(["after-work", "now"]).optional(),
  /** When the owner dismissed the notice of an automatic upgrade that finished. */
  acknowledgedAt: z.string().datetime().optional(),
});
export type InstallationUpgrade = z.infer<typeof InstallationUpgradeSchema>;

/** Reply to POST /api/installation/owner/upgrades/query. */
export const UpgradeStatusSchema = z.object({
  available: z.boolean(),
  /** Why upgrades are unavailable, or what an upgrade will replace. */
  detail: z.string(),
  repository: z.string(),
  current: z
    .object({
      sourceCommit: CommitSchema,
      release: ReleaseTagSchema.nullable(),
    })
    .nullable(),
  container: z.boolean(),
  upgrades: z.array(InstallationUpgradeSchema),
  /** Present on coordinators with update policies; its presence gates the policy routes. */
  policy: UpdatePolicySchema.optional(),
  check: UpdateCheckSchema.optional(),
});
export type UpgradeStatus = z.infer<typeof UpgradeStatusSchema>;

/** POST /api/installation/owner/upgrades creates a pending upgrade for owner review. */
export const UpgradeRequestSchema = z.strictObject({ release: ReleaseTagSchema });
export type UpgradeRequest = z.infer<typeof UpgradeRequestSchema>;

/**
 * POST /api/installation/owner/upgrades/:id/decision. `approve` restarts at once, and on an
 * upgrade waiting for current work it stops waiting; `approve-after-work` waits for current work
 * first; `acknowledge` dismisses the notice of a finished automatic upgrade. Send the last two
 * only when the status has `policy`.
 */
export const UpgradeDecisionSchema = z.strictObject({
  revision: z.string().uuid(),
  decision: z.enum(["approve", "approve-after-work", "reject", "cancel", "acknowledge"]),
});
export type UpgradeDecision = z.infer<typeof UpgradeDecisionSchema>;

/**
 * GET /api/installation/update-status, read-only for Host and Dev agents such as the Mechanic
 * and Builds. Older coordinators return 404.
 */
export const AgentUpdateStatusSchema = z.object({
  policy: UpdatePolicySchema,
  check: UpdateCheckSchema,
  /** The upgrade waiting for approval or running, without coordinator-private state. */
  active: InstallationUpgradeSchema.nullable(),
});
export type AgentUpdateStatus = z.infer<typeof AgentUpdateStatusSchema>;
