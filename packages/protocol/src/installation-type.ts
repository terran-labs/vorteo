import { z } from "zod";

/**
 * What an installation is for. `stable` installs tagged releases through tracked updates. `lab`
 * evolves itself from its live checkout: lab self-updates rebuild and swap its own coordinator
 * and Host daemon without a tag, then changes reach `main` once they are stable.
 */
export const InstallationTypeSchema = z.enum(["stable", "lab"]);
export type InstallationType = z.infer<typeof InstallationTypeSchema>;

/**
 * Which releases the update check offers. Every installation starts on `stable`, whatever its
 * type; `beta` also offers prereleases. A lab follows betas only when its operator chooses to.
 */
export const ReleaseChannelSchema = z.enum(["stable", "beta"]);
export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>;

/**
 * Owner-only status, read with `POST /api/installation/owner/installation-type/query`. Fields may
 * be added; clients must ignore unknown ones. A coordinator without the route answers 404.
 */
export const InstallationTypeStatusSchema = z.object({
  type: InstallationTypeSchema,
  /** Opaque token for compare-and-set changes. */
  revision: z.string(),
  changedAt: z.string().datetime().nullable(),
  /** Whether lab self-updates can run here; false with `labUpdateReason` when they cannot. */
  labUpdateAvailable: z.boolean().optional(),
  labUpdateReason: z.string().nullable().optional(),
  /** Absent from coordinators without release channels, which follow stable releases. */
  releaseChannel: ReleaseChannelSchema.optional(),
});
export type InstallationTypeStatus = z.infer<typeof InstallationTypeStatusSchema>;

/**
 * Body of `POST /api/installation/owner/installation-type/change`. A stale revision is refused.
 * Omitted fields keep their current value.
 */
export const InstallationTypeChangeSchema = z.strictObject({
  expectedRevision: z.string(),
  type: InstallationTypeSchema.optional(),
  releaseChannel: ReleaseChannelSchema.optional(),
});
export type InstallationTypeChange = z.infer<typeof InstallationTypeChangeSchema>;
