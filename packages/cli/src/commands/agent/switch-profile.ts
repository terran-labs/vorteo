import type { Command } from "commander";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProfileSwitchResult, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import { fetchAllAgents } from "../../utils/agent-directory.js";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";

export interface SwitchProfileOptions extends CommandOptions {
  provider?: string;
  profile?: string;
  workspace?: string;
  project?: string;
  source?: string;
  reason?: string;
  dryRun?: boolean;
}

export function addSwitchProfileOptions(command: Command): Command {
  return command
    .description("Switch idle threads to another account, preserving supported settings")
    .argument("[id]", "Thread ID, prefix, or name")
    .requiredOption("--provider <id>", "Target account/provider ID")
    .option("--profile <id>", "Target profile ID")
    .option("--workspace <id>", "Select a workspace's threads")
    .option("--project <id>", "Select a project's threads")
    .option("--source <id>", "Source account/provider ID for batch selection")
    .requiredOption("--reason <text>", "Explain the switch for the thread journal")
    .option(
      "--dry-run",
      "Check only each source thread's eligibility and scope; the target account is not checked and nothing changes",
    );
}

const schema: OutputSchema<AgentProfileSwitchResult> = {
  idField: "agentId",
  columns: [
    { header: "THREAD", field: "agentId" },
    { header: "OUTCOME", field: "outcome" },
    {
      header: "SOURCE ELIGIBLE",
      field: (result) => describeEligibility(result.preview),
    },
    { header: "CODE", field: "refusalCode" },
    { header: "PROVIDER", field: "provider" },
    { header: "MODEL", field: "model" },
    { header: "MODE", field: "modeId" },
    { header: "THINKING", field: "thinkingOptionId" },
    {
      header: "FEATURES",
      field: (result) => (result.features === undefined ? "" : JSON.stringify(result.features)),
    },
    { header: "STATUS", field: "status" },
    { header: "ERROR", field: "error" },
    { header: "AUDIT ERROR", field: "auditError" },
  ],
};

function describeEligibility(preview: AgentProfileSwitchResult["preview"]): string {
  if (!preview) return "";
  return preview.sourceEligible ? "yes" : "no";
}

interface SwitchClient {
  fetchAgents(options?: Parameters<DaemonClient["fetchAgents"]>[0]): Promise<{
    entries: { agent: AgentSnapshotPayload }[];
    pageInfo: { nextCursor: string | null };
  }>;
  fetchWorkspaces(options?: Parameters<DaemonClient["fetchWorkspaces"]>[0]): Promise<{
    entries: { id: string; projectId: string }[];
    pageInfo: { nextCursor: string | null };
  }>;
  switchAgentProfile(
    ...args: Parameters<DaemonClient["switchAgentProfile"]>
  ): ReturnType<DaemonClient["switchAgentProfile"]>;
  close(): Promise<void>;
}

export async function runSwitchProfileCommand(
  id: string | undefined,
  options: SwitchProfileOptions,
  _command: Command,
): Promise<ListResult<AgentProfileSwitchResult>> {
  return switchProfiles(id, options);
}

export async function switchProfiles(
  id: string | undefined,
  options: SwitchProfileOptions,
  connect: (
    options: Parameters<typeof connectToDaemon>[0],
  ) => Promise<SwitchClient> = connectToDaemon,
): Promise<ListResult<AgentProfileSwitchResult>> {
  validateSelection(id, options);
  const client = await connect({ target: options.daemonTarget });
  try {
    const agents = await fetchAllAgents(client, { filter: { includeArchived: true } });
    const candidates = await selectCandidates(client, agents, id, options);
    const results: AgentProfileSwitchResult[] = [];
    for (const agent of candidates) {
      try {
        const result = await client.switchAgentProfile(agent.id, {
          provider: options.provider,
          profileId: options.profile,
          explanation: options.reason.trim(),
          dryRun: options.dryRun ?? false,
          sourceScope: {
            provider: agent.provider,
            cwd: agent.cwd,
            workspaceId: agent.workspaceId,
            projectId: options.project,
          },
        });
        if (!result) throw new Error("Host returned no structured switch result");
        results.push(result);
      } catch (error) {
        results.push({
          agentId: agent.id,
          outcome: "refused",
          error: error instanceof Error ? error.message : String(error),
          refusalCode: "error",
          ...(options.dryRun ? { preview: { sourceEligible: false, targetChecked: false } } : {}),
        });
      }
    }
    return { type: "list", data: results, schema };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function validateSelection(
  id: string | undefined,
  options: SwitchProfileOptions,
): asserts options is SwitchProfileOptions & { provider: string; reason: string } {
  if (!options.reason?.trim() || !options.provider?.trim())
    throw new Error("Target provider and reason are required");
  if (id) {
    if (options.workspace || options.project || options.source)
      throw new Error("Select a thread or a batch, not both");
  } else if (!options.source || Boolean(options.workspace) === Boolean(options.project)) {
    throw new Error("Select exactly one workspace or project and a source account");
  }
}

async function selectCandidates(
  client: SwitchClient,
  agents: AgentSnapshotPayload[],
  id: string | undefined,
  options: SwitchProfileOptions,
): Promise<AgentSnapshotPayload[]> {
  if (id) {
    const resolved = resolveAgentId(id, agents);
    const agent = agents.find((candidate) => candidate.id === resolved);
    if (!agent) throw new Error(`Thread not found: ${id}`);
    return [agent];
  }
  const workspaceIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.fetchWorkspaces({ page: { limit: 200, cursor } });
    for (const workspace of page.entries) {
      if (
        options.workspace
          ? workspace.id === options.workspace
          : workspace.projectId === options.project
      )
        workspaceIds.add(workspace.id);
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents.filter(
    (agent) =>
      agent.provider === options.source &&
      agent.workspaceId !== undefined &&
      workspaceIds.has(agent.workspaceId),
  );
}
