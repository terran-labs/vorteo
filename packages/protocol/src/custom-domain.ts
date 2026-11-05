import { z } from "zod";
import { RecoveryOriginSchema } from "./execution-installation.js";

/**
 * The installation's custom domain: the coordinator's `recoveryOrigin`, an extra exact
 * HTTPS origin that serves the same interface beside `public.origin`. Owner-only. Fields
 * may be added; clients must ignore unknown ones. See docs/execution-installation.md.
 */
export const CustomDomainChangeStateSchema = z.enum([
  "running",
  "succeeded",
  "rolled-back",
  "failed",
]);
export type CustomDomainChangeState = z.infer<typeof CustomDomainChangeStateSchema>;

export const CustomDomainStatusSchema = z.object({
  /** False when this installation cannot change its domain here; `reason` says why. */
  available: z.boolean(),
  reason: z.string().nullable(),
  /** The domain the running coordinator serves, or null. */
  origin: z.string().nullable(),
  /** Opaque token for compare-and-set changes. */
  revision: z.string(),
  /** The most recent change, kept until the next one starts. */
  lastChange: z
    .object({
      id: z.string(),
      origin: z.string().nullable(),
      status: CustomDomainChangeStateSchema,
      detail: z.string(),
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().nullable(),
    })
    .nullable(),
});
export type CustomDomainStatus = z.infer<typeof CustomDomainStatusSchema>;

export const CustomDomainChangeSchema = z.strictObject({
  expectedRevision: z.string(),
  /** Null removes the custom domain. */
  origin: RecoveryOriginSchema.nullable(),
});
export type CustomDomainChange = z.infer<typeof CustomDomainChangeSchema>;
