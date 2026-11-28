import { z } from "zod";
import { MaintenanceServiceJobSchema } from "./maintenance-service.js";

/** Owner-facing queue receipt. Native custody records stay in protected storage. */
export const MaintenanceServiceViewSchema = MaintenanceServiceJobSchema.pick({
  id: true,
  revision: true,
  target: true,
  operation: true,
  reason: true,
  createdAt: true,
  status: true,
  detail: true,
}).extend({
  cancelable: z.boolean(),
  dispatchAfter: z.string().datetime().nullable(),
  generation: z.uuid().nullable(),
  outcome: z.enum(["candidate", "previous", "unknown"]).nullable(),
  observedAt: z.string().datetime().nullable(),
  // COMPAT(operationProgress): added 2026-11-28; reply-only, sent only to clients that request
  // operationProgress=1, derived from timestamps the maintenance journal already keeps. Remove the
  // request gate once every owner client floor includes these fields.
  startedAt: z.string().datetime().optional(),
  step: z.string().min(1).max(64).optional(),
  stepStartedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});
export type MaintenanceServiceView = z.infer<typeof MaintenanceServiceViewSchema>;

export const MaintenanceServiceQueueStatusSchema = z.strictObject({
  installationId: z.uuid(),
  available: z.boolean(),
  jobs: z.array(MaintenanceServiceViewSchema),
});
export type MaintenanceServiceQueueStatus = z.infer<typeof MaintenanceServiceQueueStatusSchema>;

export const MaintenanceServiceCancellationSchema = z.strictObject({
  id: z.uuid(),
  revision: z.uuid(),
});
