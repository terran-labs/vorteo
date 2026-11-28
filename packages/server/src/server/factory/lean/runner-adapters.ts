import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual, promisify } from "node:util";

import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { projectFactoryClaimBranch } from "@getpaseo/server/factory-project";
import type { Logger } from "pino";
import { z } from "zod";

import { AgentNotFoundError, ensureUnarchivedAgentLoaded } from "../../agent/agent-loading.js";
import { WorkerLaunchRefusal, type AgentManager } from "../../agent/agent-manager.js";
import { restoreStoredUsage } from "../../agent/agent-projections.js";
import { formatSystemNotificationPrompt, startAgentRun } from "../../agent/agent-prompt.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../../agent/create-agent/create.js";
import { ProviderQuotaExhaustedError } from "../../agent/quota-error.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import type { FactoryGitHub } from "../project/claims.js";
import { createAccountTable, type LeanAccountDependencies } from "./accounts.js";
import {
  createRunnerPort,
  runnerStatusFromAgent,
  type BoundRunnerOpenInput,
  type RunnerDependencies,
} from "./runners.js";
import type { ForeignReviewOpenEvidence } from "./review-evidence.js";
import { LEAN_PROTOCOL_MAJOR, type RunnerOpenInput } from "./types.js";
import type { BuilderIngress } from "./builder-ingress.js";
import {
  isRunnerRepository,
  runnerTitle,
  type BuilderWorkspacePublication,
} from "./runner-workspaces.js";

const execute = promisify(execFile);
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const remoteRef = z.object({
  ref: z.string(),
  object: z.object({ sha: z.string().regex(shaPattern) }),
});

interface WorkspaceBinding {
  workspaceId: string;
  /** Exact, authenticated PR head from the reconciler. Null for other roles. */
  reviewHead: string | null;
  title?: string;
  authorizedBuilderHead?: string;
}

class IssueAuthorityError extends Error {}

export interface LocalRunnerDependencies extends LeanAccountDependencies {
  installation: string;
  /** Repository from the daemon's project record, never from issue or agent text. */
  repository: string;
  github: FactoryGitHub;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaces: Pick<WorkspaceRegistry, "get">;
  createAgent: BoundCreateAgentCommand;
  logger: Logger;
  resolveWorkspace(input: BoundRunnerOpenInput): Promise<WorkspaceBinding>;
  /** Recheck primary authority, current owner policy and the live signed submission. */
  verifyForeignReview?(issue: number, binding: ForeignReviewOpenEvidence): Promise<boolean>;
  authorizePrimaryIssueOperation?(issue: number): Promise<boolean>;
  machineBuilderGeneration?(issue: number): Promise<string | null>;
  requiredProviderTypes?: Partial<Record<RunnerOpenInput["role"], string>>;
  recoveryIssue?: number;
  deliveryCharter?: string;
  builderIngress?: Pick<BuilderIngress, "register" | "revoke">;
  verifyBuilderPublication?(input: BuilderWorkspacePublication): Promise<boolean>;
}

export function createLocalRunnerRuntime(deps: LocalRunnerDependencies) {
  if (!isRunnerRepository(deps.repository)) {
    throw new Error("Factory runners need an authenticated project repository.");
  }
  const accounts = createAccountTable({
    ...deps,
    async roleAccounts(role) {
      const configured = await deps.roleAccounts(role);
      const required = deps.requiredProviderTypes?.[role];
      if (required && configured.providerType !== required) {
        throw new Error(`${runnerTitle(role, null)} requires the configured ${required} provider.`);
      }
      return configured;
    },
  });
  const { agentManager, agentStorage, logger } = deps;
  const loader = { agentManager, agentStorage, logger };

  async function authorizeIssue(
    input: Pick<BoundRunnerOpenInput, "projectId" | "issue" | "role" | "foreignReview">,
  ): Promise<string | null> {
    if (input.projectId !== deps.projectId)
      throw new IssueAuthorityError("The runner belongs to another project.");
    if (input.issue === null) {
      if (input.role === "lead" || input.role === "reviewer") {
        throw new IssueAuthorityError("An issue runner needs a verified issue lease.");
      }
      return null;
    }
    if (!Number.isSafeInteger(input.issue) || input.issue < 1) {
      throw new IssueAuthorityError("The runner needs a valid issue number.");
    }
    if (input.role === "foreman-op" && deps.authorizePrimaryIssueOperation) {
      if (await deps.authorizePrimaryIssueOperation(input.issue)) return null;
      throw new IssueAuthorityError(
        "The primary no longer holds authority for this issue operation.",
      );
    }
    const branch = projectFactoryClaimBranch(input.issue);
    const foreign = input.foreignReview;
    if (foreign) {
      if (
        input.role !== "reviewer" ||
        foreign.submission.installation === deps.installation ||
        !(await deps.verifyForeignReview?.(input.issue, foreign))
      ) {
        throw new IssueAuthorityError(
          "The verified foreign review target is no longer authorized.",
        );
      }
      return branch;
    }
    await requireLocalIssueLease(input.issue, branch);
    return branch;
  }

  async function requireLocalIssueLease(issue: number, branch: string): Promise<void> {
    const ledger = await deps.state.read(deps.projectId);
    const lease = ledger.leases[String(issue)];
    if (
      !lease ||
      lease.issue !== issue ||
      lease.branch !== branch ||
      lease.installation !== deps.installation ||
      lease.protocol !== LEAN_PROTOCOL_MAJOR ||
      lease.released ||
      !(Date.parse(lease.expiresAt) > deps.now().getTime())
    ) {
      throw new IssueAuthorityError("Factory no longer holds a live lease for this issue.");
    }
  }

  async function activeWorkspace(workspaceId: string) {
    const workspace = await deps.workspaces.get(workspaceId);
    if (workspace?.projectId !== deps.projectId || workspace.archivedAt !== null) {
      throw new Error("The runner needs an active workspace in this project.");
    }
    return workspace;
  }

  async function registerBuilder(agentId: string, issue: number, workspaceId: string, cwd: string) {
    await deps.builderIngress?.register({
      agentId,
      issue,
      projectId: deps.projectId,
      workspaceId,
      cwd,
    });
  }

  async function restoreBuilder(agentId: string, workspaceId: string | undefined): Promise<void> {
    if (!deps.builderIngress || !workspaceId) return;
    const row = (await deps.state.read(deps.projectId)).runners[agentId];
    if (
      !row ||
      row.closedAt !== null ||
      row.serverId !== null ||
      row.role !== "lead" ||
      row.issue === null
    )
      return;
    await authorizeIssue({ projectId: deps.projectId, issue: row.issue, role: row.role });
    const workspace = await activeWorkspace(workspaceId);
    await registerBuilder(agentId, row.issue, workspaceId, workspace.cwd);
  }

  async function prepareLaunch(launch: Parameters<RunnerDependencies["createAgent"]>[0]) {
    const { input } = launch;
    const branch = await authorizeIssue(input);
    const machineBuilder =
      input.role === "lead" && input.issue !== null && deps.machineBuilderGeneration;
    const generation = machineBuilder ? await machineBuilder(input.issue!) : null;
    if (machineBuilder && !generation)
      throw new IssueAuthorityError("The Builder needs a live local machine claim.");
    const binding = await deps.resolveWorkspace(input);
    if (machineBuilder && !shaPattern.test(binding.authorizedBuilderHead ?? "")) {
      throw new IssueAuthorityError("The Builder needs its verified starting commit.");
    }
    const workspace = await activeWorkspace(binding.workspaceId);
    if (
      input.worktree &&
      (await realpath(input.worktree.path)) !== (await realpath(workspace.cwd))
    ) {
      throw new Error("The registered workspace differs from the requested worktree.");
    }
    const review = await verifyCheckout(
      input,
      workspace.cwd,
      workspace.kind,
      branch,
      binding.reviewHead,
    );
    const identity = launch.identity;
    if (!identity) throw new Error("Reserve the Factory runner before launch.");
    await identity.seal(workspace.workspaceId, review ?? undefined);
    return { branch, machineBuilder, generation, binding, workspace, review, identity };
  }

  const createAgent: RunnerDependencies["createAgent"] = async (launch) => {
    const { input, choice } = launch;
    if (launch.serverId !== null || !choice.account) {
      throw new Error("Choose an eligible local account before opening a runner.");
    }
    const provider = choice.account;
    const { branch, machineBuilder, generation, binding, workspace, review, identity } =
      await prepareLaunch(launch);
    const issueIdentity = branch
      ? `Factory issue #${input.issue}, claim branch ${branch}.`
      : "Factory project operation.";
    const systemPrompt = builderSystemPrompt(
      launch.systemPrompt,
      input.role === "lead" && deps.builderIngress !== undefined,
    );
    const initialPrompt = [
      issueIdentity,
      review ? `Review exactly ${review.headSha}.` : "",
      binding.authorizedBuilderHead
        ? `Use ${binding.authorizedBuilderHead} as the expected remote head for Builder Git operations.`
        : "",
      launch.initialPrompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    let createdId: string | null = null;
    try {
      const result = await deps.createAgent({
        kind: "session",
        agentId: identity.agentId,
        provisionalTitle: binding.title ?? runnerTitle(input.role, input.issue),
        workspaceId: workspace.workspaceId,
        config: {
          cwd: workspace.cwd,
          provider,
          systemPrompt,
          ...(choice.profileId ? { profileId: choice.profileId } : {}),
        },
        labels: launch.labels,
        initialPrompt,
        firstAgentContext: { prompt: initialPrompt },
        origin: "agent",
        async onCreated({ agentId }) {
          createdId = agentId;
          const agent = agentManager.getAgent(agentId);
          if (agent?.provider !== provider || agent.workspaceId !== workspace.workspaceId) {
            throw new Error(
              "The daemon resolved a different account or workspace for this runner.",
            );
          }
          if (getParentAgentIdFromLabels(agent.labels)) {
            throw new Error(
              "A Factory runner must be a new daemon-created session with no parent.",
            );
          }
          await authorizeIssue(input);
          if (input.role === "lead" && input.issue !== null) {
            if (machineBuilder && generation && branch && binding.authorizedBuilderHead) {
              if ((await machineBuilder(input.issue)) !== generation)
                throw new IssueAuthorityError("The machine claim changed during Builder launch.");
              const assignment = {
                issue: input.issue,
                generation,
                workspaceId: workspace.workspaceId,
                headSha: binding.authorizedBuilderHead,
                account: provider,
                branch,
              };
              await deps.state.mutate(deps.projectId, (ledger) => {
                const launches = (ledger.hostBuilderAssignments ??= {});
                if (
                  Object.hasOwn(launches, agentId) &&
                  !isDeepStrictEqual(launches[agentId], assignment)
                )
                  throw new IssueAuthorityError("This Builder already has a saved assignment.");
                launches[agentId] = assignment;
              });
            }
            await registerBuilder(agentId, input.issue, workspace.workspaceId, workspace.cwd);
          }
        },
      });
      if (result.initialPromptError && !result.liveSnapshot.config.usageLimitHold) {
        throw result.initialPromptError;
      }
      return { agentId: result.snapshot.id, ...(review ? { review } : {}) };
    } catch (error) {
      if (createdId) {
        deps.builderIngress?.revoke(createdId);
        await agentManager.archiveAgent(createdId).catch((cleanup: unknown) => {
          logger.warn(
            { err: cleanup, agentId: createdId },
            "Could not archive a refused Factory runner",
          );
        });
      } else if (isLaunchQuota(error)) {
        return { quota: { resetsAt: null } };
      }
      throw error;
    }
  };

  const runners = createRunnerPort({
    projectId: deps.projectId,
    installation: deps.installation,
    state: deps.state,
    accounts,
    now: deps.now,
    recoveryIssue: deps.recoveryIssue,
    deliveryCharter: deps.deliveryCharter,
    async place(input) {
      if (input.worktree?.serverId) {
        return {
          parked: {
            kind: "dev-unavailable",
            reason: "This Factory runner can only use local worktrees.",
          },
        };
      }
      return { serverId: null };
    },
    createAgent,
    async discoverAgent(intent) {
      requireLocal(intent.runner.serverId);
      const stored = await agentStorage.get(intent.runner.agentId);
      if (!stored || stored.archivedAt) return "missing";
      if (!intent.workspaceId || stored.workspaceId !== intent.workspaceId) return "unverified";
      if (getParentAgentIdFromLabels(stored.labels)) return "unverified";
      if (stored.provider !== intent.runner.account) return "close";
      const workspace = await activeWorkspace(intent.workspaceId);
      const foreignReview = intent.choice.foreignReviewDecision?.binding;
      try {
        const input = {
          projectId: deps.projectId,
          issue: intent.issue,
          role: intent.runner.role,
          foreignReview,
        };
        const branch = await authorizeIssue(input);
        if (foreignReview) {
          if (intent.review?.headSha !== foreignReview.submission.head) return "close";
          await verifyCheckout(input, workspace.cwd, workspace.kind, branch, intent.review.headSha);
        }
      } catch (error) {
        if (error instanceof IssueAuthorityError) return "close";
        throw error;
      }
      return "adopt";
    },
    async verifyQuotaRecovery(runner, issue) {
      requireLocal(runner.serverId);
      const stored = await agentStorage.get(runner.agentId);
      const live = agentManager.getAgent(runner.agentId);
      const hold = live ? live.config.usageLimitHold : stored?.config?.usageLimitHold;
      if (!hold || hold.releasedAt) return "The runner no longer has a verified quota stop.";
      if (runner.role !== "lead") return null;
      if (issue === null || !stored?.workspaceId)
        return "The Builder's saved worktree is unavailable.";
      try {
        const workspace = await activeWorkspace(stored.workspaceId);
        await readLeadHead(workspace.cwd, projectFactoryClaimBranch(issue));
        return null;
      } catch (error) {
        logger.warn(
          {
            agentId: runner.agentId,
            issue,
            err: error instanceof Error ? error.name : typeof error,
          },
          "Could not verify the quota-stopped Builder's worktree",
        );
        return "The Builder's saved worktree could not be verified for quota recovery.";
      }
    },
    async subscribe({ agentId, serverId }, listener) {
      requireLocal(serverId);
      const stored = await agentStorage.get(agentId);
      if (!stored || stored.archivedAt) return null;
      const hold = stored.config?.usageLimitHold;
      const held = hold && !hold.releasedAt;
      if (!held) {
        await ensureUnarchivedAgentLoaded(agentId, loader);
        await restoreBuilder(agentId, stored.workspaceId);
      } else {
        deps.builderIngress?.revoke(agentId);
      }
      const stop = agentManager.subscribe(
        (event) => {
          if (event.type === "agent_state") {
            const status = runnerStatusFromAgent(event.agent);
            if (status.kind === "quota") deps.builderIngress?.revoke(agentId);
            listener(status);
          }
          if (event.type === "agent_removed") {
            deps.builderIngress?.revoke(agentId);
            listener({ kind: "detached" });
          }
        },
        { agentId, includeInternal: true },
      );
      if (held && !agentManager.getAgent(agentId)) {
        listener({ kind: "quota", resetsAt: hold.resetsAt ?? null, accountDefinition: null });
      }
      return stop;
    },
    async prompt(runner, message) {
      requireLocal(runner.serverId);
      const stored = await agentStorage.get(runner.agentId);
      if (!stored || stored.archivedAt) return "gone";
      const hold = stored.config?.usageLimitHold;
      if (hold && !hold.releasedAt) return "busy";
      try {
        const agent = await ensureUnarchivedAgentLoaded(runner.agentId, loader);
        const status = runnerStatusFromAgent(agent);
        if (status.kind !== "idle" || agentManager.hasInFlightRun(agent.id)) return "busy";
        await startAgentRun(
          agentManager,
          agent.id,
          formatSystemNotificationPrompt(message),
          logger,
          {
            runOptions: { origin: "agent" },
          },
        );
        return "sent";
      } catch (error) {
        if (error instanceof AgentNotFoundError) return "gone";
        throw error;
      }
    },
    async lastReply(runner) {
      requireLocal(runner.serverId);
      const reply = await agentManager.getLastAssistantMessage(runner.agentId);
      // Codex inserts this display separator before a final message following a tool call.
      const separator = "\n\n---\n\n";
      return runner.providerType === "codex" && reply?.startsWith(separator)
        ? reply.slice(separator.length)
        : reply;
    },
    async readUsage({ serverId, agentId }) {
      requireLocal(serverId);
      const live = agentManager.getAgent(agentId)?.lastUsage;
      if (live) return live;
      const stored = await agentStorage.get(agentId);
      return stored ? (restoreStoredUsage(stored) ?? null) : null;
    },
    async archiveAgent({ serverId, agentId }) {
      requireLocal(serverId);
      deps.builderIngress?.revoke(agentId);
      const stored = await agentStorage.get(agentId);
      if (!stored || stored.archivedAt) return;
      await agentManager.archiveAgent(agentId);
    },
    async checkLeadBranch(runner, issue) {
      requireLocal(runner.serverId);
      const branch = projectFactoryClaimBranch(issue);
      const record = await agentStorage.get(runner.agentId);
      if (!record?.workspaceId) return "The lead's saved worktree is unavailable.";
      try {
        const workspace = await activeWorkspace(record.workspaceId);
        const head = await readLeadHead(workspace.cwd, branch);
        const response = await deps.github.rest(
          "GET",
          `repos/${deps.repository}/git/ref/heads/${branch}`,
        );
        const pushed = remoteRef.safeParse(response.body);
        if (
          response.status !== 200 ||
          !pushed.success ||
          pushed.data.ref !== `refs/heads/${branch}`
        ) {
          return `The remote claim branch ${branch} could not be verified.`;
        }
        const remoteHead = pushed.data.object.sha;
        const published =
          remoteHead === head ||
          (await deps.verifyBuilderPublication?.({
            issue,
            workspaceId: workspace.workspaceId,
            workspaceHead: head,
            remoteHead,
          }));
        return published ? null : `Push the lead's current commit to ${branch} before closing it.`;
      } catch (error) {
        logger.warn(
          {
            agentId: runner.agentId,
            issue,
            err: error instanceof Error ? error.name : typeof error,
          },
          "Could not verify the Factory lead's branch",
        );
        return `The lead's worktree and remote claim branch ${branch} could not be verified.`;
      }
    },
  });
  return { runners, accounts };
}

function builderSystemPrompt(charter: string, authenticatedGit: boolean): string {
  if (!authenticatedGit) return charter;
  return `${charter}

Use the authenticated Factory Builder Git tools to publish approved changes and open the issue pull request. Supply the expected remote head and the exact approved file paths. The upload helper reads the files in your workspace. Use Published Head to recover a previous publication after a restart. Leave shared Git configuration, filesystem permissions and network permissions alone.`;
}

function requireLocal(serverId: string | null): void {
  if (serverId !== null) throw new Error("This Factory runtime cannot operate on a remote runner.");
}

function isLaunchQuota(error: unknown): boolean {
  return (
    error instanceof ProviderQuotaExhaustedError ||
    (error instanceof WorkerLaunchRefusal && error.code === "quota-exhausted")
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute("git", args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function readLeadHead(cwd: string, branch: string): Promise<string> {
  const active = await git(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  if (active !== `refs/heads/${branch}`) throw new Error("The worktree is on a different branch.");
  return git(cwd, ["rev-parse", "HEAD^{commit}"]);
}

async function verifyCheckout(
  input: Pick<BoundRunnerOpenInput, "role" | "foreignReview">,
  cwd: string,
  kind: string,
  branch: string | null,
  reviewHead: string | null,
) {
  if (!branch || (input.role !== "lead" && input.role !== "reviewer")) return null;
  if (kind !== "worktree") throw new Error("Issue runners require a dedicated worktree.");
  if (input.role === "lead") {
    await readLeadHead(cwd, branch);
    return null;
  }
  if (!reviewHead || !shaPattern.test(reviewHead)) {
    throw new Error("The reviewer needs an authenticated pull request head.");
  }
  if (input.foreignReview && reviewHead !== input.foreignReview.submission.head) {
    throw new IssueAuthorityError("The reviewer workspace no longer matches the verified head.");
  }
  const [head, currentBranch, dirty] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD^{commit}"]),
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["status", "--porcelain", "--untracked-files=all"]),
  ]);
  if (head !== reviewHead || currentBranch || dirty) {
    throw new Error("The reviewer needs a clean detached worktree at the exact pull request head.");
  }
  return {
    headSha: reviewHead,
    daemonCreated: true as const,
    clean: true as const,
    nonChild: true as const,
    freshSession: true as const,
  };
}
