import { z } from "zod";
import {
  projectFactoryClaimBranch,
  type ProjectFactoryIssueAgentHost,
  type ProjectFactoryQueue,
} from "@getpaseo/server/factory-project";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import { markerInstallations } from "./claims.js";
import type { DevAgent } from "./issue-agent-host.js";
import type { GhRunner } from "./tick-gate.js";

type QueueIssue = ProjectFactoryQueue["issues"][number];
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })), pageInfo }),
});
const prSchema = z.object({
  number: z.number(),
  url: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  body: z.string().default(""),
  reviewDecision: z.string().nullable(),
  commits: z.object({
    nodes: z
      .array(
        z.object({
          commit: z.object({
            statusCheckRollup: z.object({ state: z.string() }).nullable(),
          }),
        }),
      )
      .length(1),
  }),
  latestReviews: z.object({
    nodes: z.array(
      z.object({ state: z.string(), commit: z.object({ oid: z.string() }).nullable() }),
    ),
    pageInfo: z.object({ hasPreviousPage: z.boolean() }),
  }),
  comments: z.object({
    nodes: z.array(
      z.object({ body: z.string(), author: z.object({ login: z.string() }).nullable() }),
    ),
    pageInfo: z.object({ hasPreviousPage: z.boolean() }),
  }),
});
type PullRequest = z.infer<typeof prSchema>;

/** With issue agents in Dev: Dev's state and its agents, empty when Dev could not be read. */
export interface DevQueueAgents {
  host: ProjectFactoryIssueAgentHost;
  /** This installation's name; only Dev agents labeled with it count. */
  installation: string;
  agents: DevAgent[];
}

interface QueueInput {
  repository: string;
  gh: GhRunner;
  agents: () => Promise<StoredAgentRecord[]>;
  workspaceIds: ReadonlySet<string>;
  /**
   * Never rejects: an unreadable Dev comes back with no agents and the reason. Undefined when
   * there is no Dev to read.
   */
  devAgents?: () => Promise<DevQueueAgents | undefined>;
  /** Issues whose claim branch this installation created. */
  ownClaims: ReadonlySet<number>;
  now: Date;
}
class QueueReadError extends Error {}

/** A display snapshot only. The Foreman still verifies every merge gate at the exact head. */
export async function readIssueQueue(input: QueueInput): Promise<ProjectFactoryQueue> {
  const fetchedAt = input.now.toISOString();
  try {
    const [owner, name] = input.repository.split("/");
    const issues: z.infer<typeof issueSchema>[] = [];
    const prs: PullRequest[] = [];
    let cursor: string | null = null;
    let viewerLogin = "";
    do {
      const response = await input.gh.graphql(
        `query($owner:String!,$name:String!,$cursor:String) {
        ${cursor === null ? "viewer { login }" : ""}
        repository(owner:$owner,name:$name) {
          issues(first:100,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}) {
            nodes { number title url labels(first:100) { nodes { name } pageInfo { hasNextPage endCursor } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
        { owner, name, cursor },
      );
      const page = z
        .object({ nodes: z.array(issueSchema), pageInfo })
        .parse(repositoryData(response).issues);
      if (cursor === null) {
        const viewer = z
          .object({ data: z.object({ viewer: z.object({ login: z.string().min(1) }) }) })
          .parse(response);
        viewerLogin = viewer.data.viewer.login;
      }
      issues.push(...page.nodes);
      cursor = nextCursor(page.pageInfo, cursor);
    } while (cursor);
    cursor = null;
    do {
      const response = await input.gh.graphql(
        `query($owner:String!,$name:String!,$cursor:String) {
        repository(owner:$owner,name:$name) {
          pullRequests(first:100,after:$cursor,states:OPEN) {
            nodes { number url headRefName headRefOid body reviewDecision
              commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
              latestReviews(last:100) { nodes { state commit { oid } } pageInfo { hasPreviousPage } }
              comments(last:100) { nodes { body author { login } } pageInfo { hasPreviousPage } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
        { owner, name, cursor },
      );
      const page = z
        .object({ nodes: z.array(prSchema), pageInfo })
        .parse(repositoryData(response).pullRequests);
      prs.push(...page.nodes);
      cursor = nextCursor(page.pageInfo, cursor);
    } while (cursor);
    const [records, dev] = await Promise.all([input.agents(), input.devAgents?.()]);
    const queue: QueueIssue[] = [];
    for (const issue of issues) {
      if (issue.labels.pageInfo.hasNextPage)
        throw new QueueReadError("Issue labels are incomplete.");
      const names = new Set(issue.labels.nodes.map((label) => label.name));
      const label = (["blocked", "human-review", "running", "ready"] as const).find((value) =>
        names.has(`factory:${value}`),
      );
      if (!label) continue;
      const agents = [
        ...issueAgents(records, input.workspaceIds, issue.number),
        ...devIssueAgents(dev, issue.number),
      ];
      const { pull, claim } = issuePull(prs, issue.number, input.ownClaims);
      const pr = pull ? describePr(pull, viewerLogin) : null;
      const item: QueueIssue = {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        label,
        stage: "queued",
        pr,
        agents,
        claim,
      };
      item.stage = deriveStage(item, pull ? approvedHead(pull, viewerLogin) : false);
      queue.push(item);
    }
    return { fetchedAt, error: null, ...(dev ? { issueAgentHost: dev.host } : {}), issues: queue };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr
        : "";
    const detail = firstErrorLine(stderr) || firstErrorLine(message);
    return {
      fetchedAt,
      error: detail || "Could not read the Factory queue.",
      issues: [],
    };
  }
}

/** The issue's pull request and, when it comes from a claim branch, that claim's owner. */
function issuePull(prs: PullRequest[], issueNumber: number, ownClaims: ReadonlySet<number>) {
  const branch = projectFactoryClaimBranch(issueNumber);
  // Exact names avoid issue 1 matching 10. The `<prefix>/factory-issue-<n>` form predates
  // claims and stays readable until those pull requests finish.
  const pull =
    prs.find((pr) => pr.headRefName === branch) ??
    prs.find((pr) => pr.headRefName.endsWith(`/factory-issue-${issueNumber}`));
  const claim: QueueIssue["claim"] =
    pull?.headRefName === branch
      ? {
          branch,
          local: ownClaims.has(issueNumber),
          installation: markerInstallations(pull.body, branch)[0] ?? null,
        }
      : null;
  return { pull, claim };
}

function firstErrorLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^gh: /, ""))
    .find((line) => line.length > 0);
}

function repositoryData(response: unknown): Record<string, unknown> {
  const envelope = z
    .object({
      data: z
        .object({ repository: z.record(z.string(), z.unknown()).nullable() })
        .nullable()
        .optional(),
      errors: z.array(z.object({ message: z.string() })).optional(),
    })
    .parse(response);
  if (envelope.errors?.length) throw new QueueReadError(envelope.errors[0]!.message);
  if (!envelope.data?.repository) throw new QueueReadError("GitHub returned no repository data.");
  return envelope.data.repository;
}
function nextCursor(page: z.infer<typeof pageInfo>, previous: string | null): string | null {
  if (!page.hasNextPage) return null;
  if (!page.endCursor || page.endCursor === previous)
    throw new QueueReadError("GitHub returned an incomplete queue page.");
  return page.endCursor;
}
function issueAgents(
  records: StoredAgentRecord[],
  workspaceIds: ReadonlySet<string>,
  issueNumber: number,
): QueueIssue["agents"] {
  return records.flatMap((record) => {
    const belongs = record.workspaceId && workspaceIds.has(record.workspaceId);
    const role = belongs && !record.archivedAt ? issueRole(record.labels, issueNumber) : null;
    return role ? [{ role, agentId: record.id, status: record.lastStatus }] : [];
  });
}
/** Dev's workspace ids differ from this host's, so the installation label places them. */
function devIssueAgents(
  dev: DevQueueAgents | undefined,
  issueNumber: number,
): QueueIssue["agents"] {
  const serverId = dev?.host.serverId;
  if (!dev || !serverId) return [];
  return dev.agents.flatMap((agent) => {
    const ours = agent.labels["factory.installation"] === dev.installation && !agent.archivedAt;
    const role = ours ? issueRole(agent.labels, issueNumber) : null;
    return role ? [{ role, agentId: agent.id, status: agent.status, serverId }] : [];
  });
}
function issueRole(
  labels: Record<string, string>,
  issueNumber: number,
): QueueIssue["agents"][number]["role"] | null {
  if (labels["factory.issue"] !== String(issueNumber)) return null;
  const role = labels["factory.role"];
  return role === "lead" || role === "worker" || role === "reviewer" ? role : null;
}
function describePr(pr: PullRequest, viewerLogin: string): NonNullable<QueueIssue["pr"]> {
  const state = pr.commits.nodes[0]!.commit.statusCheckRollup?.state;
  let checks: NonNullable<QueueIssue["pr"]>["checks"] = null;
  if (state === "SUCCESS") checks = "passing";
  else if (state === "FAILURE" || state === "ERROR") checks = "failing";
  else if (state) checks = "pending";
  const changesRequested =
    pr.latestReviews.nodes.some((review) => review.state === "CHANGES_REQUESTED") ||
    recordedReview(pr, viewerLogin) === "changes";
  const reviewDecision = changesRequested ? "CHANGES_REQUESTED" : pr.reviewDecision;
  return {
    number: pr.number,
    url: pr.url,
    headSha: pr.headRefOid,
    checks,
    reviewDecision,
  };
}
function approvedHead(pr: PullRequest, viewerLogin: string): boolean {
  if (pr.reviewDecision === "CHANGES_REQUESTED") return false;
  const approvedReview = pr.latestReviews.nodes.some(
    (review) => review.state === "APPROVED" && review.commit?.oid === pr.headRefOid,
  );
  return approvedReview || recordedReview(pr, viewerLogin) === "approved";
}
function recordedReview(pr: PullRequest, viewerLogin: string): "approved" | "changes" | null {
  // The Foreman records its read-only reviewer's reply. This is display evidence,
  // never merge authorization; its charter still requires all merge gates.
  for (const comment of pr.comments.nodes.toReversed()) {
    if (comment.author?.login !== viewerLogin || !comment.body.startsWith("(AI Generated)."))
      continue;
    const lines = comment.body.split(/\r?\n/).map((line) => line.trim());
    if (lines.includes(`APPROVE ${pr.headRefOid}`)) return "approved";
    const findings =
      lines.includes(`Review ${pr.headRefOid}`) && lines.some((line) => /^\d+[.)]\s/.test(line));
    if (findings) return "changes";
  }
  return null;
}

function deriveStage(issue: QueueIssue, approved: boolean): QueueIssue["stage"] {
  if (issue.label === "blocked") return "blocked";
  if (issue.pr?.checks === "failing" || issue.pr?.reviewDecision === "CHANGES_REQUESTED")
    return "repair";
  const worker = issue.agents.some((agent) => agent.role === "worker");
  const lead = issue.agents.some((agent) => agent.role === "lead");
  if (lead && !worker && !issue.pr) return "planning";
  if (issue.agents.some((agent) => agent.role === "worker" && agent.status === "running"))
    return "building";
  if (issue.pr) {
    if (issue.pr.checks !== "passing") return "building";
    return approved ? "merging" : "review";
  }
  if (worker) return "building";
  if (issue.label === "human-review") return "review";
  return "queued";
}
