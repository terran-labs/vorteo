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
import {
  ISSUE_TRUST_FIELDS,
  issueTrust,
  issueTrustFactsSchema,
  type IssueTrust,
  type TrustedAccounts,
} from "./trust.js";

type QueueIssue = ProjectFactoryQueue["issues"][number];
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const issueSchema = issueTrustFactsSchema.extend({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })), pageInfo }),
});
const FACTORY_LABELS = [
  "factory:ready",
  "factory:running",
  "factory:blocked",
  "factory:human-review",
];
const prSchema = z.object({
  number: z.number(),
  url: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  /** From a fork: never an issue's pull request, whatever its branch is called. */
  isCrossRepository: z.boolean().default(false),
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
      z.object({
        state: z.string(),
        commit: z.object({ oid: z.string() }).nullable(),
        author: z.object({ login: z.string() }).nullable().optional(),
      }),
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
  issueAgents?: "dev" | "host";
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
  /** Intake trust; an issue or review it cannot vouch for is shown as untrusted. */
  trusted: () => Promise<TrustedAccounts>;
  now: Date;
}
class QueueReadError extends Error {}

export async function queueDeadline<T>(
  read: Promise<T>,
  dependency: string,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueReadError(`${dependency} timed out.`)), milliseconds);
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function queueAgents(input: QueueInput) {
  const errors: string[] = [];
  function partial(error: unknown) {
    errors.push(error instanceof Error ? error.message : String(error));
    return [];
  }
  const [records, dev] = await Promise.all([
    queueDeadline(input.agents(), "Host agent list", 2_000).catch(partial),
    input.devAgents?.(),
  ]);
  const reason = dev?.host.unavailable ?? null;
  const devIncomplete = input.issueAgents !== "host" && reason !== null;
  const degraded = devIncomplete ? `Dev agent data unavailable: ${reason}` : undefined;
  return { records, dev, errors, partial: errors.length > 0, degraded };
}

/** A display snapshot only. The Foreman still verifies every merge gate at the exact head. */
export async function readIssueQueue(input: QueueInput): Promise<ProjectFactoryQueue> {
  const fetchedAt = input.now.toISOString();
  const refreshDeadline = performance.now() + 15_000;
  function checkDeadline() {
    if (performance.now() >= refreshDeadline)
      throw new QueueReadError("Factory queue refresh timed out.");
  }
  try {
    const [owner, name] = input.repository.split("/");
    const issues: z.infer<typeof issueSchema>[] = [];
    const prs: PullRequest[] = [];
    let cursor: string | null = null;
    let viewerLogin = "";
    do {
      checkDeadline();
      const response = await queueDeadline(
        input.gh.graphql(
          `query($owner:String!,$name:String!,$cursor:String) {
        ${cursor === null ? "viewer { login }" : ""}
        repository(owner:$owner,name:$name) {
          issues(first:100,after:$cursor,states:OPEN,labels:${JSON.stringify(FACTORY_LABELS)},orderBy:{field:CREATED_AT,direction:ASC}) {
            nodes { number title url ${ISSUE_TRUST_FIELDS} labels(first:100) { nodes { name } pageInfo { hasNextPage endCursor } } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
          { owner, name, cursor },
        ),
        "GitHub queue read",
        5_000,
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
      checkDeadline();
      const response = await queueDeadline(
        input.gh.graphql(
          `query($owner:String!,$name:String!,$cursor:String) {
        repository(owner:$owner,name:$name) {
          pullRequests(first:100,after:$cursor,states:OPEN) {
            nodes { number url headRefName headRefOid isCrossRepository body reviewDecision
              commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
              latestReviews(last:100) { nodes { state commit { oid } author { login } } pageInfo { hasPreviousPage } }
              comments(last:100) { nodes { body author { login } } pageInfo { hasPreviousPage } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
          { owner, name, cursor },
        ),
        "GitHub queue read",
        5_000,
      );
      const page = z
        .object({ nodes: z.array(prSchema), pageInfo })
        .parse(repositoryData(response).pullRequests);
      prs.push(...page.nodes);
      cursor = nextCursor(page.pageInfo, cursor);
    } while (cursor);
    const { records, dev, errors, partial, degraded } = await queueAgents(input);
    const { verdict: trustVerdict, sameRepository } = await trustEvidence(input, prs);
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
      const { pull, claim } = issuePull(sameRepository, issue.number, input.ownClaims);
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
        ...(await trustVerdict(issue)),
      };
      item.stage = deriveStage(item, pull ? approvedHead(pull, viewerLogin) : false);
      queue.push(item);
    }
    return {
      fetchedAt,
      error: errors.join(" ") || null,
      partial,
      degraded,
      ...(dev ? { issueAgentHost: dev.host } : {}),
      issues: queue,
    };
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

/**
 * Pull requests from this repository with only trusted reviews, and a verdict per issue. When
 * the trusted accounts cannot be read, every issue is shown as unverified.
 */
async function trustEvidence(input: QueueInput, prs: PullRequest[]) {
  let lookup: TrustedAccounts;
  let trustError: string | null = null;
  try {
    lookup = await input.trusted();
  } catch (error) {
    trustError = errorMessage(error);
    lookup = async () => false;
  }
  // A failed lookup of one login (a 403 or 429 for someone who reviewed or commented) counts
  // that login as untrusted and is reported on the issues it affects; the read goes on.
  const failures = new Map<string, string>();
  const trusted: TrustedAccounts = async (login) => {
    try {
      return await lookup(login);
    } catch (error) {
      if (login) failures.set(login, errorMessage(error));
      return false;
    }
  };
  const sameRepository = prs.filter((pr) => !pr.isCrossRepository);
  for (const pr of sameRepository) {
    // Anyone can review a public pull request; only trusted reviewers count, even for display.
    const kept = [];
    for (const review of pr.latestReviews.nodes)
      if (await trusted(review.author?.login)) kept.push(review);
    pr.latestReviews.nodes = kept;
  }
  /** The queue item's optional `untrusted` field, empty for a trusted issue. */
  const verdict = async (issue: z.infer<typeof issueSchema>): Promise<{ untrusted?: string }> => {
    if (trustError)
      return { untrusted: `Could not verify who approved issue #${issue.number}: ${trustError}` };
    const before = new Set(failures.keys());
    const result: IssueTrust = await issueTrust(issue, trusted);
    if (result.trusted) return {};
    const failed = [...failures].find(
      ([login]) => !before.has(login) || issueLogins(issue).has(login),
    );
    return {
      untrusted: failed
        ? `Could not verify whether @${failed[0]} is trusted for issue #${issue.number}: ${failed[1]}`
        : result.reason,
    };
  };
  return { verdict, sameRepository };
}

/** Every account that wrote, edited, retitled or labeled the issue. */
function issueLogins(issue: z.infer<typeof issueSchema>): Set<string> {
  return new Set(
    [
      issue.author?.login,
      ...issue.userContentEdits.nodes.map((edit) => edit.editor?.login),
      ...issue.timelineItems.nodes.map((item) => item.actor?.login),
    ].filter((login): login is string => Boolean(login)),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The issue's pull request and, when it comes from a claim branch, that claim's owner. Callers
 * pass only pull requests from this repository: a fork can name its branch anything.
 */
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
    if (comment.author?.login !== viewerLogin) continue;
    const header = /^\(AI Generated\)\.?(?:\n\n|\r\n\r\n)/.exec(comment.body);
    if (!header) continue;
    const lines = comment.body
      .slice(header[0].length)
      .split(/\r?\n/)
      .map((line) => line.trim());
    const verdict = lines.find((line) => line.length > 0);
    if (verdict === `APPROVE ${pr.headRefOid}`) return "approved";
    const findings =
      verdict === `Review ${pr.headRefOid}` && lines.some((line) => /^\d+[.)]\s/.test(line));
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
