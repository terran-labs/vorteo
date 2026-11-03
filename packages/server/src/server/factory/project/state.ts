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

const ProjectStateSchema = z.object({
  repository: z.string(),
  enabled: z.boolean(),
  paused: z.boolean(),
  workers: z.object({ workerProfileId: nullableId, reviewerProfileId: nullableId }),
  roles: z.partialRecord(ProjectFactoryRoleIdSchema, RoleStateSchema),
  /**
   * The Optimizer review heartbeat Factory owns pausing. Recorded before the pause and kept
   * until a resume succeeds, so startup can reconcile either half after a crash or failure.
   */
  pausedOptimizerScheduleId: z.string().optional(),
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
