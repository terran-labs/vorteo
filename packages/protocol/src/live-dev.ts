import { z } from "zod";

/**
 * Installation delivery mode. `reliable` serves the published static interface; `live` serves
 * the Expo web dev server from the Host's live checkout to the owner's browser. See
 * docs/live-dev-mode.md.
 */
export const LiveDevModeSchema = z.enum(["reliable", "live"]);
export type LiveDevMode = z.infer<typeof LiveDevModeSchema>;

export const LiveDevServerStateSchema = z.enum(["stopped", "starting", "ready", "failed"]);
export type LiveDevServerState = z.infer<typeof LiveDevServerStateSchema>;

/** Owner-only status. Fields may be added; clients must ignore unknown ones. */
export const LiveDevStatusSchema = z.object({
  /** False when this installation cannot run live mode; `reason` says why. */
  available: z.boolean(),
  reason: z.string().nullable(),
  mode: LiveDevModeSchema,
  /** Opaque token for compare-and-set changes. */
  revision: z.string(),
  changedAt: z.string().datetime().nullable(),
  server: z.object({
    state: LiveDevServerStateSchema,
    detail: z.string().nullable(),
  }),
  checkout: z
    .object({
      path: z.string(),
      branch: z.string().nullable(),
      head: z.string().nullable(),
    })
    .nullable(),
});
export type LiveDevStatus = z.infer<typeof LiveDevStatusSchema>;

export const LiveDevChangeSchema = z.strictObject({
  expectedRevision: z.string(),
  mode: LiveDevModeSchema,
});
export type LiveDevChange = z.infer<typeof LiveDevChangeSchema>;
