import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import type { AgentStorage } from "../../agent/agent-storage.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import type { FactoryGitHub } from "../project/claims.js";
import { z } from "zod";

import {
  createBuilderBindingReader,
  createBuilderGitInvocation,
  createBuilderIngress,
  createBuilderPublicationVerifier,
} from "./builder-ingress.js";
import { BuilderGitRefusal, builderOpenPullInput } from "./builder-git.js";
import { builderGitMethods } from "./builder-git-tools.js";
import {
  builderUploadRequest,
  createMacBuilderUploader,
  type BuilderUploadSession,
} from "./builder-upload.js";
import type { LeanLedger, LeanStateStore, RunnerRef } from "./types.js";

const replyHeader = "FACTORY BUILDER READY";
const planHeader = "FACTORY BUILDER PLAN";
const planLine = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((line) => !/\p{Cc}/u.test(line) && !line.includes("<!--"));
const builderPlanReply = z.strictObject({
  issue: z.number().int().positive(),
  approach: planLine,
  tests: planLine,
  risks: planLine,
  outOfScope: planLine,
  files: z
    .array(
      z
        .string()
        .max(255)
        .regex(/^[\w.@+-][\w.@+/-]*$/)
        .refine(
          (path) =>
            !path.split("/").some((segment) => !segment || segment === "." || segment === ".."),
        ),
    )
    .min(1)
    .max(64),
  heavy: z.boolean(),
});
const replySchema = builderUploadRequest.extend({
  planId: z.string().regex(/^[a-f0-9]{64}$/),
  title: builderOpenPullInput.shape.title,
  body: builderOpenPullInput.shape.body.refine((body) => !body.includes("<!--")),
});
const published = z.object({ head: builderOpenPullInput.shape.expectedHead });
const pull = z.object({
  number: z.number().int().positive(),
  head: builderOpenPullInput.shape.expectedHead,
});

interface ApprovedPlan {
  planId: string;
  expectedHead: string;
  approvedPaths: readonly string[];
  protectedPaths: readonly string[];
  baseBranch: string;
}

export interface BuilderPublicationOptions {
  socketRoot: string;
  privateRoot: string;
  /** Set by the daemon-local loader so a workspace cannot contain its own provisioning. */
  provisionFile?: string;
  /** Configured Host Codex CLI capable of a one-process Unix socket allowance. */
  codexPath: string;
  /** Optional Builder-only GitHub port with protected PR creation; never a shared caller ingress. */
  github?: FactoryGitHub;
}

interface BuilderRuntimeDependencies {
  options: BuilderPublicationOptions;
  projectId: string;
  installation: string;
  repository: string;
  issue: number;
  state: LeanStateStore;
  now(): Date;
  github: FactoryGitHub;
  agents: Pick<AgentStorage, "get">;
  workspaces: Pick<WorkspaceRegistry, "get">;
  /** Null unless this installation holds an active publication-capable intake lane. */
  readIntakeEpoch(): Promise<number | null>;
  readApprovedPlan(agentId: string): Promise<ApprovedPlan | null>;
}

interface ReplyLedger extends LeanLedger {
  builderReplyPublications?: {
    [key: string]: { issue: number; agentId: string; head: string; pull: number | null };
  };
}

export function builderPlanId(plan: {
  commentId: number;
  postedAt: string;
  files: string[];
  heavy: boolean;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([plan.commentId, plan.postedAt, plan.files, plan.heavy]))
    .digest("hex");
}

export function builderReplyInstructions(
  planId: string,
  expectedHead: string,
  issue: number,
): string {
  return `When finished, write the exact line ${replyHeader} followed by one JSON object. Use issue ${issue}, planId "${planId}" and expectedHead "${expectedHead}". Include message (commit message), title and body (pull request summary without attribution or claim markers), and files (array of changed paths, each with kind "write" or "delete"). Supply paths only. The daemon reads the bytes, commits, pushes and opens the pull request.`;
}

export function builderPlanInstructions(issue: number): string {
  return `If your current issue-comment path can post the plan without a permission request, use it. Otherwise finish your planning turn with the exact line ${planHeader} followed by one JSON object with issue ${issue}, approach, tests, risks, outOfScope (each a single line), files (an array of repository-relative paths), and heavy (true or false). The daemon posts the plan. Wait for go before editing.`;
}

export function readBuilderPlanReply(reply: string, issue: number) {
  if (!reply.startsWith(planHeader + "\n")) return null;
  try {
    const raw = reply.slice(planHeader.length + 1);
    if (Buffer.byteLength(raw) <= 24 * 1024) {
      const parsed = builderPlanReply.parse(JSON.parse(raw));
      if (parsed.issue === issue) return parsed;
    }
  } catch {
    // The same structure is required for every planning turn.
  }
  throw new BuilderGitRefusal(
    "The Builder reply must contain a valid plan for the assigned issue.",
  );
}

export function builderPlanComment(plan: z.infer<typeof builderPlanReply>, marker: string): string {
  return [
    "## Resolution plan",
    marker,
    `Approach: ${plan.approach}`,
    `Tests: ${plan.tests}`,
    `Risks: ${plan.risks}`,
    `Out of scope: ${plan.outOfScope}`,
    "### Files",
    ...new Set(plan.files),
    `Heavy: ${plan.heavy ? "yes" : "no"}`,
  ].join("\n");
}

/** The daemon supplies the assigned idle runner and its durable last assistant message. */
export function createProjectBuilderRuntime(deps: BuilderRuntimeDependencies) {
  const { projectId, state, issue, repository, installation, now, agents, workspaces } = deps;
  let uploader: ((session: BuilderUploadSession) => Promise<void>) | null = null;
  const readBinding = createBuilderBindingReader({
    projectId,
    installation,
    state,
    agents,
    workspaces,
    now,
    readIntakeEpoch: deps.readIntakeEpoch,
    readApprovedPlan: (agentId, requestedIssue) =>
      requestedIssue === issue ? deps.readApprovedPlan(agentId) : Promise.resolve(null),
  });
  async function currentBinding(agentId: string) {
    const binding = await readBinding(agentId);
    if (!binding) return null;
    const { socketRoot, privateRoot, provisionFile, codexPath } = deps.options;
    if (
      [provisionFile, codexPath, socketRoot, privateRoot].some(
        (path) => path && (contains(binding.cwd, path) || contains(path, binding.cwd)),
      )
    )
      return null;
    return binding;
  }
  const ingress = createBuilderIngress({
    socketRoot: deps.options.socketRoot,
    currentBinding,
    async runUploader(session) {
      uploader ??= createMacBuilderUploader(deps.options.codexPath);
      await uploader(session);
    },
    invokeGit: createBuilderGitInvocation(async (requestedProjectId) => {
      if (requestedProjectId !== projectId) return null;
      return {
        projectId,
        repository,
        installation,
        state,
        now,
        privateRoot: deps.options.privateRoot,
        github: deps.options.github ?? deps.github,
        async allowWrites() {
          return (await deps.readIntakeEpoch()) !== null;
        },
        async readAuthority(agentId, requestedIssue) {
          if (requestedIssue !== issue) return null;
          const authorized = await currentBinding(agentId);
          const plan = await deps.readApprovedPlan(agentId);
          if (!authorized || !plan || authorized.planId !== plan.planId) return null;
          return { ...plan, workspaceId: authorized.workspaceId };
        },
      };
    }),
  });

  async function capture(runner: RunnerRef, reply: string | null): Promise<boolean> {
    if (
      runner.role !== "lead" ||
      runner.serverId !== null ||
      !reply?.startsWith(replyHeader + "\n")
    )
      return false;
    const raw = reply.slice(replyHeader.length + 1);
    if (Buffer.byteLength(raw) > 96 * 1024)
      throw new BuilderGitRefusal("The Builder publication reply is too large.");
    const request = parseReply(raw);
    const key = createHash("sha256")
      .update(JSON.stringify([runner.agentId, request]))
      .digest("hex");
    const recorded: ReplyLedger = await state.read(projectId);
    const previous = recorded.builderReplyPublications?.[key];
    if (previous?.pull) return false;
    const current = await currentBinding(runner.agentId);
    const plan = current && (await deps.readApprovedPlan(runner.agentId));
    if (
      !current ||
      !plan ||
      request.issue !== issue ||
      current.issue !== issue ||
      request.planId !== current.planId ||
      request.planId !== plan.planId ||
      request.expectedHead !== plan.expectedHead
    ) {
      throw new BuilderGitRefusal(
        "The Builder reply does not match the active issue, approved plan and issued head.",
      );
    }
    const { planId: _planId, title, body, ...upload } = request;
    const receipt =
      previous ??
      published.parse(await ingress.invoke(runner.agentId, builderGitMethods.publish, upload));
    if (!previous) {
      await state.mutate(projectId, (ledger: ReplyLedger) => {
        (ledger.builderReplyPublications ??= {})[key] ??= {
          issue,
          agentId: runner.agentId,
          head: receipt.head,
          pull: null,
        };
      });
    }
    const opened = pull.parse(
      await ingress.invoke(runner.agentId, builderGitMethods.openPullRequest, {
        issue,
        expectedHead: receipt.head,
        title,
        body,
      }),
    );
    if (opened.head !== receipt.head)
      throw new BuilderGitRefusal("Factory could not verify the published pull request head.");
    await state.mutate(projectId, (ledger: ReplyLedger) => {
      (ledger.builderReplyPublications ??= {})[key] = {
        issue,
        agentId: runner.agentId,
        head: receipt.head,
        pull: opened.number,
      };
    });
    return true;
  }

  return {
    ingress,
    capture,
    verifyBuilderPublication: createBuilderPublicationVerifier(state, projectId),
  };
}

function parseReply(raw: string) {
  try {
    return replySchema.parse(JSON.parse(raw));
  } catch {
    throw new BuilderGitRefusal(
      "The Builder reply must contain one valid publication object after its header.",
    );
  }
}

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}
