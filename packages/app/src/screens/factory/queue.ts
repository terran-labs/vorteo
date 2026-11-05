import { z } from "zod";

const QueueSchema = z.object({
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
export type FactoryQueue = z.infer<typeof QueueSchema>;
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
