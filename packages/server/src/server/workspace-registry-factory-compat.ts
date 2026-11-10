// Retained only to read older project records; the retired controller no longer writes checkpoints.
import { z } from "zod";

const identity = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\S(?:.*\S)?$/);
const coordinator = z.object({ workspaceId: identity, agentId: identity });

/** Native project state, never a caller-settable project label or custody journal. */
export const FactoryInstallCheckpointSchema = z
  .object({
    serverId: identity,
    projectId: identity,
    installationId: identity,
    operationId: identity,
    revision: identity,
    observedAt: z.iso.datetime(),
    stage: z.enum(["binding", "attached"]),
    coordinators: z.object({ factory: coordinator, builds: coordinator }),
  })
  .superRefine((value, ctx) => {
    const { factory, builds } = value.coordinators;
    if (factory.workspaceId === builds.workspaceId || factory.agentId === builds.agentId)
      ctx.addIssue({
        code: "custom",
        message: "Factory coordinators must have distinct identities",
      });
  });
