import { z } from "zod";
import type { ProjectFactoryState } from "@/components/sidebar/factory-state";

const QueueSchema = z.object({
  degraded: z.string().optional(),
  refreshing: z.boolean().optional(),
  partial: z.boolean().optional(),
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
      /** Optional for older daemons; local=false means another installation owns the issue. */
      claim: z
        .object({ branch: z.string(), local: z.boolean(), installation: z.string().nullable() })
        .nullable()
        .optional(),
    }),
  ),
});
export type FactoryQueue = z.infer<typeof QueueSchema>;
interface QueueRefreshInput {
  queue: FactoryQueue | null | undefined;
  enabled: boolean;
  polling: boolean;
  steadyMs?: number;
}
export function factoryQueueRefreshInterval(input: QueueRefreshInput): number | false {
  if (!input.enabled || input.queue === null) return false;
  if (input.queue?.refreshing) return 2_000;
  return input.polling ? (input.steadyMs ?? 120_000) : false;
}
export type FactoryInvoke = (method: string, input: unknown) => Promise<unknown>;

export async function loadFactoryQueue(
  invoke: FactoryInvoke,
  projectId: string,
): Promise<FactoryQueue | null> {
  try {
    return QueueSchema.parse(await invoke("factory.project.queue", { projectId }));
  } catch (error) {
    // Native routing and plugin runtimes report missing methods at different boundaries.
    if (!(error instanceof Error)) throw error;
    const missingMethod = /^Unknown (Factory|RPC) method: factory\.project\.queue$/.test(
      error.message,
    );
    const missingContribution =
      error.message === "Plugin factory does not contribute RPC factory.project.queue";
    if (missingMethod || missingContribution) return null;
    throw error;
  }
}

const agentStatuses = [
  "initializing",
  "running",
  "idle",
  "error",
  "stopped",
  "completed",
  "failed",
  "canceled",
] as const;
export function factoryAgentStatusKey(status: string) {
  const known = agentStatuses.find((candidate) => candidate === status);
  return `projectFactory.agentStatuses.${known ?? "unknown"}` as const;
}

export type FactoryAssignedRole = "triage" | "releases";
export type FactoryRoleRunner =
  | { kind: "here" }
  | { kind: "other"; installation: string }
  | { kind: "nobody" }
  | { kind: "everyone" }
  /** The daemon has not read `.github/factory.json` yet. */
  | { kind: "pending" };
export interface FactoryRoleAssignment {
  role: FactoryAssignedRole;
  runner: FactoryRoleRunner;
  /** True when this installation does not run the role. */
  offHere: boolean;
  /** Why the role is off here when `.github/factory.json` could not be used. */
  detail: string | null;
}

/** Null when the daemon predates role assignment, so the overview hides the section. */
export function factoryRoleAssignments(
  state: Pick<ProjectFactoryState, "installation" | "assignment">,
): FactoryRoleAssignment[] | null {
  const { installation, assignment } = state;
  if (!assignment && installation === undefined) return null;
  const roles: FactoryAssignedRole[] = ["triage", "releases"];
  return roles.map((role) => {
    if (!assignment) return { role, runner: { kind: "pending" }, offHere: false, detail: null };
    if (assignment.source === "none") {
      return { role, runner: { kind: "everyone" }, offHere: false, detail: null };
    }
    if (assignment.source !== "file") {
      return { role, runner: { kind: "nobody" }, offHere: true, detail: assignment.detail };
    }
    const owner = assignment[role];
    if (owner === null) return { role, runner: { kind: "nobody" }, offHere: true, detail: null };
    if (owner === installation)
      return { role, runner: { kind: "here" }, offHere: false, detail: null };
    return { role, runner: { kind: "other", installation: owner }, offHere: true, detail: null };
  });
}
