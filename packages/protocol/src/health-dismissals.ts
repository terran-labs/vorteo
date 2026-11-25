import { z } from "zod";

/**
 * The owner's dismissals of failed maintenance records, kept beside the records rather than in
 * them: the job schemas are strict, so a new field there would break older interfaces reading a
 * newer coordinator. A dismissed failure stays in its history; System Health stops counting it.
 *
 * Routes, owner session only (agents can never clear a failure from the owner's Health list):
 * - POST /api/installation/owner/health-dismissals/query answers `HealthDismissals`.
 * - POST /api/installation/owner/health-dismissals takes `HealthDismissalRequest` and answers
 *   `HealthDismissals`. Coordinators without the routes answer 404, which the interface reads as
 *   "Dismiss is unavailable here".
 */

/** The queues whose failed records can be dismissed. Upgrades use their own `acknowledge`. */
export const HealthDismissalQueueSchema = z.enum([
  "preview-broker",
  "preview-monitor",
  "native-helper",
  "session-host",
  "maintenance-service",
  "restart",
]);
export type HealthDismissalQueue = z.infer<typeof HealthDismissalQueueSchema>;

// Read tolerantly: a newer coordinator may dismiss records in queues this interface predates.
export const HealthDismissalSchema = z.object({
  queue: z.string().min(1).max(100),
  id: z.string().min(1).max(200),
  dismissedAt: z.string().datetime(),
});
export type HealthDismissal = z.infer<typeof HealthDismissalSchema>;

export const HealthDismissalsSchema = z.object({
  dismissals: z.array(HealthDismissalSchema),
});
export type HealthDismissals = z.infer<typeof HealthDismissalsSchema>;

export const HealthDismissalRequestSchema = z.strictObject({
  queue: HealthDismissalQueueSchema,
  id: z.string().min(1).max(200),
});
export type HealthDismissalRequest = z.infer<typeof HealthDismissalRequestSchema>;
