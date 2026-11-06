import { z } from "zod";
import { InstallationTypeSchema } from "./installation-type.js";

// Lab self-updates rebuild the coordinator and Host daemon from the Host's live checkout and
// restart both, on installations whose type is `lab`. Owner routes live under
// /api/installation/owner/lab-updates; Host agents use /api/installation/lab-update-requests.
// Coordinators without the feature answer 404. Fields may be added; clients must ignore unknown
// ones. See docs/live-dev-mode.md#fast-track-daemon-restarts.

export const LabUpdateStepNameSchema = z.enum(["build", "host", "coordinator"]);
export type LabUpdateStepName = z.infer<typeof LabUpdateStepNameSchema>;

export const LAB_UPDATE_STEP_LABELS: Record<LabUpdateStepName, string> = {
  build: "Build from the live checkout",
  host: "Restart the Host daemon on the new release",
  coordinator: "Replace the installation coordinator",
};

export const LabUpdateStepSchema = z.object({
  name: LabUpdateStepNameSchema,
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped", "rolled-back"]),
  detail: z.string(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});
export type LabUpdateStep = z.infer<typeof LabUpdateStepSchema>;

/** A live checkout file with uncommitted changes when the build cloned it. */
export const LabUpdateDirtyFileSchema = z.object({
  file: z.string(),
  /** The `live-dev claim` owner, or null when nobody claimed the file. */
  claimedBy: z.string().nullable(),
});

export const LabUpdateSchema = z.object({
  id: z.string().uuid(),
  /** Changes on every transition; cancellation must name the revision it reviewed. */
  revision: z.string().uuid(),
  /** `rollback` reselects the releases an earlier update replaced, without building. */
  kind: z.enum(["update", "rollback"]),
  rollbackOf: z.string().uuid().optional(),
  status: z.enum(["approved", "running", "succeeded", "failed", "cancelled"]),
  detail: z.string(),
  reason: z.string(),
  requestedBy: z.enum(["owner", "host-agent"]),
  requester: z.string().optional(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  /** The approval policy decision. Lab installations approve their own self-updates. */
  approval: z.object({
    policy: z.literal("lab-installation-type"),
    installationType: InstallationTypeSchema,
    decidedAt: z.string().datetime(),
  }),
  /** What the build cloned. Null until the build reads the checkout, and for rollbacks. */
  source: z
    .object({
      checkout: z.string(),
      branch: z.string().nullable(),
      head: z.string().nullable(),
      dirty: z.array(LabUpdateDirtyFileSchema),
    })
    .nullable(),
  /** The release directory this job selects. */
  release: z.string().nullable(),
  /** The releases selected before this job, which rollback restores. */
  previous: z.object({ host: z.string().nullable(), coordinator: z.string().nullable() }),
  /** The tracked Host restart in the restart queue, once requested. */
  hostRestartId: z.string().uuid().optional(),
  steps: z.array(LabUpdateStepSchema),
});
export type LabUpdate = z.infer<typeof LabUpdateSchema>;

/** Reply to POST /api/installation/owner/lab-updates/query. Newest first. */
export const LabUpdateStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  type: InstallationTypeSchema,
  updates: z.array(LabUpdateSchema),
});
export type LabUpdateStatus = z.infer<typeof LabUpdateStatusSchema>;

/** Body of POST /api/installation/owner/lab-updates and /api/installation/lab-update-requests. */
export const LabUpdateRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000).optional(),
  requester: z.string().trim().min(1).max(200).optional(),
  /** Restore the releases this earlier update replaced instead of building. */
  rollbackOf: z.string().uuid().optional(),
});
export type LabUpdateRequest = z.infer<typeof LabUpdateRequestSchema>;

/** Body of POST /api/installation/owner/lab-updates/cancel. */
export const LabUpdateCancelSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.string().uuid(),
});
export type LabUpdateCancel = z.infer<typeof LabUpdateCancelSchema>;
