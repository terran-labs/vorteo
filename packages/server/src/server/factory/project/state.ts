import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ProjectFactoryRoleIdSchema } from "@getpaseo/server/factory-project";

import { writeJsonFileAtomic } from "../../atomic-file.js";

const nullableId = z.string().min(1).nullable();

const InstructionsStateSchema = z.object({
  additions: z.string(),
  revision: z.number().int().min(0),
  updatedAt: z.string().nullable(),
  history: z.array(
    z.object({ revision: z.number().int().min(1), additions: z.string(), updatedAt: z.string() }),
  ),
  basedOn: z.object({ charterVersion: z.string(), charterText: z.string() }).nullable(),
  review: z.object({
    status: z.enum(["none", "needed", "proposed"]),
    proposal: z
      .object({ text: z.string(), rationale: z.string(), proposedAt: z.string() })
      .optional(),
  }),
  /** Shipped charter version the Mechanic was last told about, so it hears once per change. */
  notifiedCharterVersion: z.string().optional(),
});
export type InstructionsState = z.infer<typeof InstructionsStateSchema>;

const RoleStateSchema = z.object({
  workspaceId: nullableId,
  agentId: nullableId,
  launch: z.object({ provider: nullableId, profileId: nullableId }),
  /** The launch last applied to the agent; differs from `launch` until a switch succeeds. */
  appliedLaunch: z.object({ provider: nullableId, profileId: nullableId }).optional(),
  status: z.object({ line: z.string(), updatedAt: z.string() }).nullable(),
  instructions: InstructionsStateSchema,
  /**
   * Hash of the effective instructions the agent last received, keyed to that agent. Any
   * charter input or addition change alters the hash, so the next tick delivers it once.
   */
  delivered: z
    .object({ agentId: z.string(), hash: z.string().optional() })
    .passthrough()
    .optional(),
  /** Set when an operator clears the role's launch; the next apply switches to the default once. */
  resetLaunch: z.boolean().optional(),
  gate: z.object({ fingerprint: z.string().nullable(), lastWakeAt: z.string().nullable() }),
});
export type RoleState = z.infer<typeof RoleStateSchema>;

/**
 * A claim this installation made. "pending" is written before the branch is created, so a
 * crash between creation and the state write is recovered from this record. "conflict" means
 * another installation's marker names the same branch; it counts as not ours until the owner
 * decides.
 */
const ClaimStateSchema = z.object({
  branch: z.string(),
  status: z.enum(["pending", "held", "conflict"]),
  attemptId: z.string(),
  /** Default-branch commit the claim branch was created at. */
  baseSha: z.string(),
  startedAt: z.string(),
  claimedAt: z.string().optional(),
  /** Archive refs for this issue that existed at claim time; a new one means it was released. */
  archivesAtClaim: z.array(z.string()),
  /** Installations whose markers on this branch the owner overruled in a conflict. */
  overruled: z.array(z.string()).optional(),
});
export type ClaimState = z.infer<typeof ClaimStateSchema>;

/** A claim branch this installation did not create, as last observed. */
const ForeignClaimSchema = z.object({
  headSha: z.string(),
  /** When this installation first saw this head; a lower bound on its age. */
  seenAt: z.string(),
  /** When the Foreman was told this head is stale; once per head. */
  notifiedAt: z.string().optional(),
});
export type ForeignClaimState = z.infer<typeof ForeignClaimSchema>;

const AssignmentStateSchema = z.object({
  source: z.enum(["none", "file", "invalid", "unreadable"]),
  triage: z.string().nullable(),
  releases: z.string().nullable(),
  detail: z.string().nullable(),
  readAt: z.string(),
});
export type AssignmentState = z.infer<typeof AssignmentStateSchema>;

const ProjectStateSchema = z.object({
  repository: z.string(),
  enabled: z.boolean(),
  paused: z.boolean(),
  workers: z.object({
    plannerProfileId: nullableId.default(null),
    planning: z.boolean().default(true),
    workerProfileId: nullableId,
    reviewerProfileId: nullableId,
  }),
  roles: z.partialRecord(ProjectFactoryRoleIdSchema, RoleStateSchema),
  /**
   * The Optimizer review heartbeat Factory owns pausing. Recorded before the pause and kept
   * until a resume succeeds, so startup can reconcile either half after a crash or failure.
   */
  pausedOptimizerScheduleId: z.string().optional(),
  /** Claims this installation made, keyed by issue number. */
  claims: z.record(z.string(), ClaimStateSchema).optional(),
  /** Claim branches other installations hold, keyed by branch name. */
  foreignClaims: z.record(z.string(), ForeignClaimSchema).optional(),
  /** Recent account picks for new Factory agents, newest last and bounded. */
  accountPicks: z
    .array(
      z.object({
        stage: z.enum(["planner", "worker", "reviewer"]),
        issue: z.number().int().optional(),
        profileId: z.string().nullable(),
        provider: z.string().nullable(),
        remainingPct: z.number().nullable(),
        bound: z.boolean().optional(),
        /** The connected host the agent starts on, when not this daemon. */
        serverId: z.string().optional(),
        pickedAt: z.string(),
      }),
    )
    .optional(),
  /** The last `.github/factory.json` read. */
  assignment: AssignmentStateSchema.optional(),
  /**
   * Set when pause_all paused this project. resume_all resumes only these, and any manual
   * pause, resume or turn off clears it, so an operator's own pause is never undone.
   */
  drain: z
    .object({
      /** New for every drain. A drain recorded before ids existed takes one from its time. */
      id: z.string().min(1).optional(),
      reason: z.string(),
      pausedAt: z.string(),
      /** When the Foreman's drain notice was queued; unset until a send succeeds. */
      noticeSentAt: z.string().optional(),
    })
    // A legacy drain's notice predates ids, so its Foreman could never acknowledge it by id.
    // Deriving the id also forgets that notice; the next pause_all sends one with the id, and
    // the next write persists both.
    .transform(({ id, noticeSentAt, ...drain }) =>
      id
        ? { ...drain, id, ...(noticeSentAt ? { noticeSentAt } : {}) }
        : { ...drain, id: `drain-${drain.pausedAt}` },
    )
    .optional(),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;

const StateFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    projects: z.record(z.string(), ProjectStateSchema),
  })
  .passthrough();
export type ProjectFactoryStateFile = z.infer<typeof StateFileSchema>;

export function projectFactoryStatePath(paseoHome: string): string {
  return path.join(paseoHome, "factory", "projects.json");
}

export function emptyRoleState(): RoleState {
  return {
    workspaceId: null,
    agentId: null,
    launch: { provider: null, profileId: null },
    status: null,
    instructions: {
      additions: "",
      revision: 0,
      updatedAt: null,
      history: [],
      basedOn: null,
      review: { status: "none" },
    },
    gate: { fingerprint: null, lastWakeAt: null },
  };
}

export class ProjectFactoryStateDamagedError extends Error {
  constructor(readonly filePath: string) {
    super(
      `The Factory state file ${filePath} is damaged. Fix or remove it; Factory changes nothing until then.`,
    );
    this.name = "ProjectFactoryStateDamagedError";
  }
}

/**
 * Daemon-owned record of every project's Factory: role agents and workspaces, repository,
 * enablement, instructions and tick memory. Writes are atomic and serialized; a damaged
 * file is never overwritten, because that could forget agents the daemon already created.
 */
export class ProjectFactoryStateStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<ProjectFactoryStateFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 1, projects: {} };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProjectFactoryStateDamagedError(this.filePath);
    }
    const result = StateFileSchema.safeParse(parsed);
    if (!result.success) throw new ProjectFactoryStateDamagedError(this.filePath);
    return result.data;
  }

  /** Runs one read-modify-write at a time. The mutator may return a value. */
  mutate<T>(mutator: (state: ProjectFactoryStateFile) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const state = await this.read();
      const result = await mutator(state);
      await writeJsonFileAtomic(this.filePath, StateFileSchema.parse(state));
      return result;
    };
    const result = this.pending.then(run, run);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
