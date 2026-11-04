import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Stored role identities, in sidebar folder order. Never rename one: state files keep them. */
export const PROJECT_FACTORY_ROLE_IDS = [
  "factory-triage",
  "factory-intake",
  "factory-builds",
  "factory-releases",
  "factory-mechanic",
] as const;

export const ProjectFactoryRoleIdSchema = z.enum(PROJECT_FACTORY_ROLE_IDS);
export type ProjectFactoryRoleId = z.infer<typeof ProjectFactoryRoleIdSchema>;

export const PROJECT_FACTORY_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** GitHub repository as owner/name. */
export const ProjectFactoryRepositorySchema = z
  .string()
  .regex(PROJECT_FACTORY_REPOSITORY_PATTERN, "Use a GitHub repository as owner/name.");

const projectId = z.string().min(1);
const nullableId = z.string().min(1).nullable();
const reviewStatus = z.enum(["none", "needed", "proposed"]);

/**
 * Instruction write conflicts. Plugin RPC errors reach clients as messages only, so clients
 * recognize a conflict by these exact openings and reload instead of failing.
 */
export const PROJECT_FACTORY_INSTRUCTION_CONFLICTS = {
  revision: "These instructions changed since you loaded them",
  proposalReplaced: "The Mechanic replaced this proposal since you loaded it",
  noProposal: "There is no proposal to accept for this role",
} as const;

/** Longest role status line, after trimming. */
export const PROJECT_FACTORY_STATUS_LINE_MAX = 120;

/**
 * A pause_all drain. Each drain gets a new id; the Foreman's "Drained <id>" status line
 * acknowledges exactly that drain, so a stale acknowledgment never satisfies a new one.
 */
export const ProjectFactoryDrainSchema = z.object({
  id: z.string().min(1),
  reason: z.string(),
  pausedAt: z.string(),
});

export const ProjectFactoryStateSchema = z.object({
  schemaVersion: z.literal(1),
  serverId: z.string().min(1),
  projectId,
  state: z.enum(["off", "on", "paused", "unavailable"]),
  repository: ProjectFactoryRepositorySchema.nullable(),
  /** Human-readable; set for "unavailable". */
  reason: z.string().nullable(),
  workers: z.object({
    plannerProfileId: nullableId.optional(),
    planning: z.boolean().optional(),
    workerProfileId: nullableId,
    reviewerProfileId: nullableId,
  }),
  /** The current pause_all drain, if any. Optional so older daemons still parse. */
  drain: ProjectFactoryDrainSchema.nullable().optional(),
  roles: z.array(
    z.object({
      role: ProjectFactoryRoleIdSchema,
      /** Display name, such as "Foreman". */
      title: z.string(),
      workspaceId: nullableId,
      agentId: nullableId,
      heartbeat: z.object({ cron: z.string(), paused: z.boolean() }).nullable(),
      /** The configured launch; null fields fall back to the daemon's default selection. */
      launch: z.object({ provider: nullableId, profileId: nullableId }),
      status: z.object({ line: z.string(), updatedAt: z.string() }).nullable(),
      instructions: z.object({ revision: z.number().int().min(0), review: reviewStatus }),
    }),
  ),
});
export type ProjectFactoryState = z.infer<typeof ProjectFactoryStateSchema>;

const projectInput = z.strictObject({ projectId });
const roleInput = z.strictObject({ projectId, role: ProjectFactoryRoleIdSchema });

export const factoryProjectGet = defineRpc({
  name: "factory.project.get",
  input: projectInput,
  output: ProjectFactoryStateSchema,
});

export const ProjectFactoryQueueSchema = z.object({
  fetchedAt: z.string(),
  error: z.string().nullable(),
  issues: z.array(
    z.object({
      number: z.number().int(),
      title: z.string(),
      url: z.string(),
      label: z.enum(["ready", "running", "blocked", "human-review"]),
      stage: z.enum(["queued", "planning", "building", "review", "repair", "merging", "blocked"]),
      pr: z
        .object({
          number: z.number().int(),
          url: z.string(),
          headSha: z.string(),
          checks: z.enum(["pending", "passing", "failing"]).nullable(),
          reviewDecision: z.string().nullable(),
        })
        .nullable(),
      agents: z.array(
        z.object({
          role: z.enum(["lead", "worker", "reviewer"]),
          agentId: z.string(),
          status: z.string(),
        }),
      ),
    }),
  ),
});
export type ProjectFactoryQueue = z.infer<typeof ProjectFactoryQueueSchema>;
export const factoryProjectQueue = defineRpc({
  name: "factory.project.queue",
  input: projectInput,
  output: ProjectFactoryQueueSchema,
});

export const factoryProjectEnable = defineRpc({
  name: "factory.project.enable",
  input: z.strictObject({
    projectId,
    repository: ProjectFactoryRepositorySchema,
    /** Existing agents to bind to roles instead of creating new ones. */
    adopt: z.partialRecord(ProjectFactoryRoleIdSchema, z.string().min(1)).optional(),
  }),
  output: ProjectFactoryStateSchema,
});

export const factoryProjectPause = defineRpc({
  name: "factory.project.pause",
  input: projectInput,
  output: ProjectFactoryStateSchema,
});

export const factoryProjectResume = defineRpc({
  name: "factory.project.resume",
  input: projectInput,
  output: ProjectFactoryStateSchema,
});

export const factoryProjectDisable = defineRpc({
  name: "factory.project.disable",
  input: projectInput,
  output: ProjectFactoryStateSchema,
});

export const factoryProjectConfigure = defineRpc({
  name: "factory.project.configure",
  input: z.strictObject({
    projectId,
    /** With a role, provider and profileId set that role's launch; null clears it. */
    role: ProjectFactoryRoleIdSchema.optional(),
    provider: nullableId.optional(),
    profileId: nullableId.optional(),
    plannerProfileId: nullableId.optional(),
    planning: z.boolean().optional(),
    workerProfileId: nullableId.optional(),
    reviewerProfileId: nullableId.optional(),
  }),
  output: ProjectFactoryStateSchema,
});

export const factoryProjectStatusSet = defineRpc({
  name: "factory.project.status.set",
  input: z.strictObject({
    projectId,
    role: ProjectFactoryRoleIdSchema,
    /** Trimmed; an empty line clears the status. */
    line: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().max(PROJECT_FACTORY_STATUS_LINE_MAX)),
  }),
  output: ProjectFactoryStateSchema,
});

export const ProjectFactoryListSchema = z.object({
  projects: z.array(
    z.object({
      projectId,
      state: z.enum(["off", "on", "paused", "unavailable"]),
      repository: ProjectFactoryRepositorySchema.nullable(),
      paused: z.boolean(),
      /** Set while pause_all holds this project; resume_all releases exactly these. */
      drain: ProjectFactoryDrainSchema.nullable(),
    }),
  ),
});
export type ProjectFactoryList = z.infer<typeof ProjectFactoryListSchema>;

/** Default pause_all reason, used by the CLI when none is given. */
export const PROJECT_FACTORY_DRAIN_REASON = "drain before restart";

export const factoryProjectList = defineRpc({
  name: "factory.project.list",
  input: z.strictObject({}),
  output: ProjectFactoryListSchema,
});

export const factoryProjectPauseAll = defineRpc({
  name: "factory.project.pause_all",
  input: z.strictObject({ reason: z.string().trim().min(1).max(500) }),
  output: ProjectFactoryListSchema,
});

export const factoryProjectResumeAll = defineRpc({
  name: "factory.project.resume_all",
  input: z.strictObject({}),
  output: ProjectFactoryListSchema,
});

export const factoryProjectSendThread = defineRpc({
  name: "factory.project.send_thread",
  input: z.strictObject({ projectId, agentId: z.string().min(1) }),
  output: z.object({ queued: z.literal(true) }),
});

const charterSnapshot = z.object({ charterVersion: z.string(), charterText: z.string() });

export const ProjectFactoryInstructionsSchema = z.object({
  role: ProjectFactoryRoleIdSchema,
  /** The charter this daemon ships for the role, rendered with the project's inputs. */
  shippedCharter: z.string(),
  charterVersion: z.string(),
  additions: z.string(),
  revision: z.number().int().min(0),
  updatedAt: z.string().nullable(),
  history: z.array(
    z.object({
      revision: z.number().int().min(1),
      additions: z.string(),
      updatedAt: z.string(),
    }),
  ),
  /** The shipped charter the additions were last reviewed against. */
  basedOn: charterSnapshot.nullable(),
  review: z.object({
    status: reviewStatus,
    proposal: z
      .object({ text: z.string(), rationale: z.string(), proposedAt: z.string() })
      .optional(),
  }),
});
export type ProjectFactoryInstructions = z.infer<typeof ProjectFactoryInstructionsSchema>;

export const factoryProjectInstructionsGet = defineRpc({
  name: "factory.project.instructions.get",
  input: roleInput,
  output: ProjectFactoryInstructionsSchema,
});

export const factoryProjectInstructionsSet = defineRpc({
  name: "factory.project.instructions.set",
  input: z.strictObject({
    projectId,
    role: ProjectFactoryRoleIdSchema,
    additions: z.string(),
    expectedRevision: z.number().int().min(0),
  }),
  output: ProjectFactoryInstructionsSchema,
});

export const factoryProjectInstructionsPropose = defineRpc({
  name: "factory.project.instructions.propose",
  input: z.strictObject({
    projectId,
    role: ProjectFactoryRoleIdSchema,
    text: z.string(),
    rationale: z.string().min(1),
  }),
  output: ProjectFactoryInstructionsSchema,
});

export const factoryProjectInstructionsAcknowledge = defineRpc({
  name: "factory.project.instructions.acknowledge",
  input: roleInput,
  output: ProjectFactoryInstructionsSchema,
});

export const factoryProjectInstructionsResolve = defineRpc({
  name: "factory.project.instructions.resolve",
  input: z
    .strictObject({
      projectId,
      role: ProjectFactoryRoleIdSchema,
      accept: z.boolean(),
      expectedRevision: z.number().int().min(0),
      /** The proposal the operator saw; accepting refuses any other. */
      proposedAt: z.string().min(1).optional(),
    })
    .refine((value) => !value.accept || value.proposedAt !== undefined, {
      message: "Accepting a proposal requires its proposedAt.",
      path: ["proposedAt"],
    }),
  output: ProjectFactoryInstructionsSchema,
});

/** Every per-project Factory method the daemon serves natively. */
export const PROJECT_FACTORY_RPCS = [
  factoryProjectGet,
  factoryProjectQueue,
  factoryProjectEnable,
  factoryProjectPause,
  factoryProjectResume,
  factoryProjectDisable,
  factoryProjectConfigure,
  factoryProjectStatusSet,
  factoryProjectSendThread,
  factoryProjectList,
  factoryProjectPauseAll,
  factoryProjectResumeAll,
  factoryProjectInstructionsGet,
  factoryProjectInstructionsSet,
  factoryProjectInstructionsPropose,
  factoryProjectInstructionsAcknowledge,
  factoryProjectInstructionsResolve,
] as const;
