import { z } from "zod";
import { ProjectFactoryStateSchema as SharedFactoryStateSchema } from "../../../../../plugins/factory/shared/project";

// Keep additions optional at the wire boundary while older daemons remain supported.
export const ProjectFactoryStateSchema = SharedFactoryStateSchema.extend({
  workers: SharedFactoryStateSchema.shape.workers.extend({
    plannerProfileId: z.string().nullable().optional(),
    planning: z.boolean().optional(),
  }),
  drain: z
    .object({ id: z.string(), reason: z.string(), pausedAt: z.string() })
    .nullable()
    .optional(),
});
export type ProjectFactoryState = z.infer<typeof ProjectFactoryStateSchema>;
