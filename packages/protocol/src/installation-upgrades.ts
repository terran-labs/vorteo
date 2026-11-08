import { z } from "zod";
import { DelegatedMaintenanceApprovalSchema } from "./maintenance-approval.js";

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
  /** Why the offer was held back, such as a source upgrade running. Absent when it was not. */
  note: z.string().optional(),
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
      /** Set when a source upgrade installed a commit ahead of this release. */
      aheadOf: ReleaseTagSchema.optional(),
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
 * Owner-approved upgrade of a Stable installation to one reviewed commit on `main`, served
 * under /api/installation/owner/source-upgrades. Gated on `sourceUpgrade` in
 * /api/installation/capabilities; older coordinators return 404. It runs the release upgrade's
 * steps, journaled apart from release upgrades so older coordinators never read these records.
 */
export const SourceUpgradeSchema = InstallationUpgradeSchema.omit({
  release: true,
  origin: true,
  notes: true,
  automatic: true,
  acknowledgedAt: true,
}).extend({
  kind: z.literal("source-upgrade"),
  /** Why the owner wants this commit before the next release. */
  reason: z.string().min(1).max(500),
  requestedBy: z.string().min(1).max(200),
  /** The newest release the target commit contains, or null when unknown. */
  lastRelease: ReleaseTagSchema.nullable(),
  /** Set on an owner rollback: the source upgrade whose previous Host release it reselects. */
  rollbackOf: z.string().uuid().optional(),
  /** When a rollback's 24-hour window ends. Approval and the fetch step refuse it afterwards. */
  rollbackUntil: z.string().datetime().optional(),
});
export type SourceUpgrade = z.infer<typeof SourceUpgradeSchema>;

/** Reply to POST /api/installation/owner/source-upgrades/query. */
export const SourceUpgradeStatusSchema = z.object({
  available: z.boolean(),
  /** Why source upgrades are unavailable, or what one replaces. */
  detail: z.string(),
  current: z
    .object({
      sourceCommit: CommitSchema,
      /** The release the installed commit was installed from or, ahead of a release, contains. */
      lastRelease: ReleaseTagSchema.nullable(),
      /** True when the installed commit came from a source upgrade, ahead of `lastRelease`. */
      ahead: z.boolean(),
    })
    .nullable(),
  /** The owner rollback of the newest source upgrade, offered for 24 hours after it finished. */
  rollback: z.object({
    available: z.boolean(),
    detail: z.string(),
    upgradeId: z.string().uuid().optional(),
    /** The Host commit a rollback reselects. */
    commit: CommitSchema.optional(),
    until: z.string().datetime().optional(),
  }),
  upgrades: z.array(SourceUpgradeSchema),
});
export type SourceUpgradeStatus = z.infer<typeof SourceUpgradeStatusSchema>;

/** POST /api/installation/owner/source-upgrades creates a pending source upgrade for review. */
export const SourceUpgradeRequestSchema = z.strictObject({
  commit: CommitSchema,
  reason: z.string().min(1).max(500),
});
export type SourceUpgradeRequest = z.infer<typeof SourceUpgradeRequestSchema>;

/** POST /api/installation/owner/source-upgrades/rollback names the source upgrade to undo. */
export const SourceUpgradeRollbackRequestSchema = z.strictObject({ upgradeId: z.string().uuid() });
export type SourceUpgradeRollbackRequest = z.infer<typeof SourceUpgradeRollbackRequestSchema>;

/** POST /api/installation/owner/source-upgrades/:id/decision. Never approved automatically. */
export const SourceUpgradeDecisionSchema = z.strictObject({
  revision: z.string().uuid(),
  decision: z.enum(["approve", "approve-after-work", "reject", "cancel"]),
});
export type SourceUpgradeDecision = z.infer<typeof SourceUpgradeDecisionSchema>;

/**
 * Moves an installer-layout coordinator onto the Host's selected release, which Host source
 * updates replace without touching the coordinator. Served under
 * /api/installation/owner/coordinator-follow; older coordinators return 404.
 */
export const CoordinatorFollowJobSchema = z.object({
  id: z.string().uuid(),
  /** Changes on every transition; decisions must name the revision they reviewed. */
  revision: z.string().uuid(),
  createdAt: z.string().datetime(),
  status: z.enum([
    "pending",
    "approved",
    "running",
    "succeeded",
    "failed",
    "rolled-back",
    "rejected",
    "cancelled",
  ]),
  detail: z.string(),
  /** The Host release the owner reviewed. The coordinator moves to exactly this release. */
  next: z.string(),
  /** The release the coordinator link selected when the replacement started. */
  previous: z.string().optional(),
  /** Absent for owner requests and from older coordinators. */
  requestedBy: z.enum(["owner", "host-agent"]).optional(),
  /** The Host agent's own label, such as "Builds". Display only, never authority. */
  requester: z.string().optional(),
  /**
   * Set when the full maintenance grant approved a Host-agent request. The job stays pending,
   * cancellable, until `dispatchAfter`, then starts if the same grant, revision and release hold.
   */
  delegatedApproval: DelegatedMaintenanceApprovalSchema.optional(),
  approvedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});
export type CoordinatorFollowJob = z.infer<typeof CoordinatorFollowJobSchema>;

/** Reply to POST /api/installation/owner/coordinator-follow/query. */
export const CoordinatorFollowStatusSchema = z.object({
  /** True when the coordinator can move onto the Host release now. */
  available: z.boolean(),
  /** Why it cannot, or what differs. */
  detail: z.string(),
  current: z
    .object({
      /** The release the coordinator service link selects. */
      coordinatorRelease: z.string(),
      /** The release the running coordinator process was started from. */
      runningRelease: z.string(),
      /** The Host release selected now. */
      hostRelease: z.string(),
    })
    .nullable(),
  /** The job waiting or running, or the newest one that finished recently. */
  job: CoordinatorFollowJobSchema.nullable(),
});
export type CoordinatorFollowStatus = z.infer<typeof CoordinatorFollowStatusSchema>;

/** POST /api/installation/owner/coordinator-follow. `next` repeats the reviewed Host release. */
export const CoordinatorFollowRequestSchema = z.strictObject({ next: z.string().startsWith("/") });
export type CoordinatorFollowRequest = z.infer<typeof CoordinatorFollowRequestSchema>;

/**
 * POST /api/installation/coordinator-follow, Host agents only. `next` names the Host release the
 * request was prepared against; it is refused when that release is no longer selected.
 */
export const CoordinatorFollowAgentRequestSchema = z.strictObject({
  next: z.string().startsWith("/"),
  requester: z.string().min(1).max(256).optional(),
});
export type CoordinatorFollowAgentRequest = z.infer<typeof CoordinatorFollowAgentRequestSchema>;

/** POST /api/installation/owner/coordinator-follow/:id/decision. */
export const CoordinatorFollowDecisionSchema = z.strictObject({
  revision: z.string().uuid(),
  decision: z.enum(["approve", "reject", "cancel"]),
});
export type CoordinatorFollowDecision = z.infer<typeof CoordinatorFollowDecisionSchema>;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * One registered key of a coordinator settings change. Keys the registry does not mark
 * display-safe omit `before` and `after`, so the owner sees only that the key changed.
 */
/** One changed field of a structured setting, as readable text rather than a JSON blob. */
export const CoordinatorSettingFieldSchema = z.object({
  /** Where in the setting, such as `worker` or `modules[2]`. */
  field: z.string(),
  /** A file shows as its path and the first 12 hex digits of its SHA-256; null when unset. */
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** The coordinator hashed the named file itself and it matched. */
  verified: z.boolean().optional(),
});
export type CoordinatorSettingField = z.infer<typeof CoordinatorSettingFieldSchema>;

export const CoordinatorSettingChangeSchema = z.object({
  key: z.string(),
  displaySafe: z.boolean(),
  /** JSON text of the value before the change, or null when unset. */
  before: z.string().nullable().optional(),
  /** JSON text of the value after the change, or null when the change removes the key. */
  after: z.string().nullable().optional(),
  /** Per-field changes of a reviewed structured setting; older coordinators omit it. */
  fields: z.array(CoordinatorSettingFieldSchema).optional(),
});
export type CoordinatorSettingChange = z.infer<typeof CoordinatorSettingChangeSchema>;

/**
 * Changes registered keys of the coordinator's own configuration file, then restarts the
 * coordinator on it; the previous file is restored if it does not answer. Served under
 * /api/installation/owner/coordinator-settings; older coordinators return 404.
 */
export const CoordinatorSettingsJobSchema = z.object({
  id: z.string().uuid(),
  /** Changes on every transition; decisions must name the revision they reviewed. */
  revision: z.string().uuid(),
  createdAt: z.string().datetime(),
  status: CoordinatorFollowJobSchema.shape.status,
  detail: z.string(),
  /** SHA-256 of the configuration file the change was prepared against. */
  baseSha256: Sha256Schema,
  changes: z.array(CoordinatorSettingChangeSchema),
  requester: z.string().optional(),
  /**
   * The coordinator update approved in the same owner decision. The settings apply once it
   * succeeds; if it fails, this is cleared and the settings stay pending.
   */
  approvedWith: z.string().uuid().optional(),
  /** Set when the full maintenance grant approved it; pending and cancellable until `dispatchAfter`. */
  delegatedApproval: DelegatedMaintenanceApprovalSchema.optional(),
  approvedAt: z.string().datetime().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});
export type CoordinatorSettingsJob = z.infer<typeof CoordinatorSettingsJobSchema>;

/** Reply to POST /api/installation/owner/coordinator-settings/query. */
export const CoordinatorSettingsStatusSchema = z.object({
  /** True when this coordinator can change its settings. */
  available: z.boolean(),
  detail: z.string(),
  /** The job waiting or running, or the newest one that finished recently. */
  job: CoordinatorSettingsJobSchema.nullable(),
});
export type CoordinatorSettingsStatus = z.infer<typeof CoordinatorSettingsStatusSchema>;

/**
 * POST /api/installation/coordinator-settings-requests, Host agents only. A null value
 * removes the key. `baseSha256` comes from GET /api/installation/coordinator-settings.
 */
export const CoordinatorSettingsRequestSchema = z.strictObject({
  patch: z.record(z.string(), z.unknown()),
  baseSha256: Sha256Schema,
  requester: z.string().min(1).max(256).optional(),
});
export type CoordinatorSettingsRequest = z.infer<typeof CoordinatorSettingsRequestSchema>;

/**
 * POST /api/installation/owner/coordinator-settings/:id/decision. With `follow`, an approval
 * first approves that pending coordinator update and applies the settings after it succeeds.
 */
export const CoordinatorSettingsDecisionSchema = z.strictObject({
  revision: z.string().uuid(),
  decision: z.enum(["approve", "reject", "cancel"]),
  follow: z.strictObject({ id: z.string().uuid(), revision: z.string().uuid() }).optional(),
  /**
   * The owner interface rendered each change's `fields`. Coordinators refuse to approve
   * reviewed broker settings without it. Send it only for a job whose changes carry `fields`:
   * older coordinators never return them and refuse unknown decision fields.
   */
  reviewedFields: z.literal(true).optional(),
});
export type CoordinatorSettingsDecision = z.infer<typeof CoordinatorSettingsDecisionSchema>;

/**
 * GET /api/installation/update-status, read-only for Host and Dev agents such as the Mechanic
 * and Builds. Older coordinators return 404.
 */
export const AgentUpdateStatusSchema = z.object({
  policy: UpdatePolicySchema,
  check: UpdateCheckSchema,
  /** The upgrade waiting for approval or running, without coordinator-private state. */
  active: InstallationUpgradeSchema.nullable(),
  /** Absent from coordinators without the coordinator replacement. Agents request it but never decide it. */
  coordinatorFollow: CoordinatorFollowStatusSchema.pick({
    available: true,
    detail: true,
    job: true,
  })
    .extend({
      /** The releases a request must name; absent from older coordinators. */
      current: CoordinatorFollowStatusSchema.shape.current.optional(),
    })
    .optional(),
  /** Absent from coordinators without coordinator settings changes. Agents never decide it. */
  coordinatorSettings: CoordinatorSettingsStatusSchema.optional(),
});
export type AgentUpdateStatus = z.infer<typeof AgentUpdateStatusSchema>;
