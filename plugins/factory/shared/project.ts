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

/**
 * Who runs Triage and Releases for a repository, from `.github/factory.json` on its default
 * branch. "none" means no file, so every installation keeps single-installation behavior.
 * "invalid" and "unreadable" turn both roles off here until the file reads cleanly.
 */
export const ProjectFactoryAssignmentSchema = z.object({
  source: z.enum(["none", "file", "invalid", "unreadable"]),
  triage: z.string().nullable(),
  releases: z.string().nullable(),
  /** Why the file could not be used; null when it was. */
  detail: z.string().nullable(),
  readAt: z.string(),
});
export type ProjectFactoryAssignment = z.infer<typeof ProjectFactoryAssignmentSchema>;

/** The roles `.github/factory.json` assigns to one installation per repository. */
export const PROJECT_FACTORY_ASSIGNED_ROLES = {
  "factory-triage": "triage",
  "factory-releases": "releases",
} as const;

/** The branch that claims an issue for exactly one installation. */
export function projectFactoryClaimBranch(issue: number): string {
  return `factory/issue-${issue}`;
}

/**
 * Where the Foreman's per-issue leads, workers and reviewers run: the Dev container, which
 * runs untrusted repository code, or this host. Factory role agents always stay here.
 */
export const ProjectFactoryIssueAgentsSchema = z.enum(["dev", "host"]);
export type ProjectFactoryIssueAgents = z.infer<typeof ProjectFactoryIssueAgentsSchema>;

/** The connected Dev host issue agents start on, or why it cannot take them now. */
export const ProjectFactoryIssueAgentHostSchema = z.object({
  /** Dev's server id once learned; null when Dev was never reached. */
  serverId: z.string().nullable(),
  /** Why Dev cannot take new issue agents, such as "Dev is offline"; null when it can. */
  unavailable: z.string().nullable(),
});
export type ProjectFactoryIssueAgentHost = z.infer<typeof ProjectFactoryIssueAgentHostSchema>;

export const ProjectFactoryStateSchema = z.object({
  schemaVersion: z.literal(1),
  serverId: z.string().min(1),
  projectId,
  /**
   * `<serverId>/<projectId>`: this installation's name in claim markers and
   * `.github/factory.json`. Optional so older daemons still parse.
   */
  installation: z.string().min(1).optional(),
  /** The last `.github/factory.json` read; null before the first. Optional for older daemons. */
  assignment: ProjectFactoryAssignmentSchema.nullable().optional(),
  /**
   * The installation environment that runs Factory for this repository; `here` is false when
   * another one does. Null outside an installation or while Factory is off. Optional for older
   * daemons.
   */
  home: z
    .object({
      environment: z.enum(["host", "container"]),
      projectId: z.string().nullable(),
      here: z.boolean(),
    })
    .nullable()
    .optional(),
  state: z.enum(["off", "on", "paused", "unavailable"]),
  repository: ProjectFactoryRepositorySchema.nullable(),
  /** Human-readable; set for "unavailable". */
  reason: z.string().nullable(),
  workers: z.object({
    plannerProfileId: nullableId.optional(),
    planning: z.boolean().optional(),
    workerProfileId: nullableId,
    reviewerProfileId: nullableId,
    /** Absent from older daemons, which run issue agents here. */
    issueAgents: ProjectFactoryIssueAgentsSchema.optional(),
  }),
  /**
   * Dev's availability, set when issue agents run in Dev or the owner's Dev host exists, since
   * agents started there keep running after a switch. Only `get` reports it.
   */
  issueAgentHost: ProjectFactoryIssueAgentHostSchema.nullable().optional(),
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
  /** GitHub is current but optional agent evidence is unavailable. */
  degraded: z.string().optional(),
  /** A display refresh is running; the returned snapshot remains usable. */
  refreshing: z.boolean().optional(),
  /** GitHub evidence is present but an agent dependency could not be read. */
  partial: z.boolean().optional(),
  fetchedAt: z.string(),
  error: z.string().nullable(),
  /**
   * Whether Dev's agents could be read, set whenever Dev is observed (see the project state).
   * When not, `agents` lists only this host's, so an issue may show fewer agents than it has.
   */
  issueAgentHost: ProjectFactoryIssueAgentHostSchema.nullable().optional(),
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
          /** The connected host the agent runs on; absent for this host. */
          serverId: z.string().optional(),
        }),
      ),
      /**
       * The claim branch's owner when its PR comes from `factory/issue-<n>`. A foreign claim
       * belongs to another installation, which this one never starts, repairs or merges.
       */
      claim: z
        .object({
          branch: z.string(),
          local: z.boolean(),
          /** From the PR's claim marker; null when the PR carries none. */
          installation: z.string().nullable(),
        })
        .nullable()
        .optional(),
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
    issueAgents: ProjectFactoryIssueAgentsSchema.optional(),
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

export const ProjectFactoryClaimSchema = z.object({
  issue: z.number().int(),
  branch: z.string(),
  /**
   * claimed: this call created the branch. held: this installation already owns it.
   * foreign: another installation does. lost: this installation's claim was released.
   * conflict: another installation's marker names this branch too; ask the owner.
   */
  outcome: z.enum(["claimed", "held", "foreign", "lost", "conflict"]),
  installation: z.string(),
  headSha: z.string().nullable(),
  /** Lines to put in the plan comment and PR body; set when this installation owns the claim. */
  marker: z.string().nullable(),
});
export type ProjectFactoryClaim = z.infer<typeof ProjectFactoryClaimSchema>;

const issueInput = z.strictObject({ projectId, issue: z.number().int().positive() });

/** Claims an issue by creating its branch on GitHub; GitHub, not timing, decides the owner. */
export const factoryProjectClaim = defineRpc({
  name: "factory.project.claim",
  input: issueInput.extend({
    /**
     * After the owner chose this installation in a conflict: keep the claim and ignore the
     * other installation's existing markers on this branch.
     */
    keep: z.boolean().optional(),
  }),
  output: ProjectFactoryClaimSchema,
});

export const ProjectFactoryClaimReleaseSchema = z.object({
  issue: z.number().int(),
  branch: z.string(),
  /**
   * archived: a stale foreign claim moved to `archivedAs` with its commits intact.
   * forgotten: this installation dropped its own conflicting claim; GitHub is unchanged.
   * absent: there was no claim branch to release.
   */
  outcome: z.enum(["archived", "forgotten", "absent"]),
  archivedAs: z.string().nullable(),
  headSha: z.string().nullable(),
});
export type ProjectFactoryClaimRelease = z.infer<typeof ProjectFactoryClaimReleaseSchema>;

/** Runs only after the owner answers the stale or conflicting claim question yes. */
export const factoryProjectClaimRelease = defineRpc({
  name: "factory.project.claim.release",
  input: issueInput,
  output: ProjectFactoryClaimReleaseSchema,
});

export const ProjectFactoryStageSchema = z.enum(["planner", "worker", "reviewer"]);

export const ProjectFactoryAccountPickSchema = z.object({
  stage: ProjectFactoryStageSchema,
  /** The stage's configured profile, or null for the installation default. */
  profileId: z.string().nullable(),
  /** The account to launch on; null means none qualifies, so use the configured default. */
  provider: z.string().nullable(),
  /** The chosen account's lowest remaining window, in percent. */
  remainingPct: z.number().nullable(),
  /**
   * True when the stage profile is bound to one account (a local profile or an older
   * shared-workflow reference), so that account is used without ranking.
   */
  bound: z.boolean(),
  /**
   * The connected host the agent starts on, when not this daemon. Then `provider` and each
   * considered `provider` are that host's local account ids.
   */
  serverId: z.string().optional(),
  /**
   * Every account of the profile's provider type, with why it was or was not chosen. For
   * another host, only accounts that host has ready are listed.
   */
  considered: z.array(
    z.object({
      provider: z.string(),
      /** For another host, this daemon's id for the same account, whose usage ranked it. */
      localProvider: z.string().optional(),
      verdict: z.enum(["qualifies", "unknown", "stale", "exhausted", "avoided"]),
      remainingPct: z.number().nullable(),
    }),
  ),
  pickedAt: z.string(),
});
export type ProjectFactoryAccountPick = z.infer<typeof ProjectFactoryAccountPickSchema>;

/**
 * Picks the account a new worker, reviewer or planner starts on by the most fresh remaining
 * quota, and records the choice. Advisory at launch: it never switches a running agent.
 */
export const factoryProjectPickAccount = defineRpc({
  name: "factory.project.pick_account",
  input: z.strictObject({
    projectId,
    stage: ProjectFactoryStageSchema,
    issue: z.number().int().positive().optional(),
    /**
     * An account to leave out, such as the worker's when picking its reviewer. For another
     * host, either that host's id or this daemon's id for the account.
     */
    avoid: z.string().min(1).optional(),
    /**
     * The connected host the agent will start on; absent means this daemon. The pick then
     * names that host's account for the same installation account.
     */
    serverId: z.string().min(1).optional(),
  }),
  output: ProjectFactoryAccountPickSchema,
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
  factoryProjectClaim,
  factoryProjectClaimRelease,
  factoryProjectPickAccount,
] as const;
