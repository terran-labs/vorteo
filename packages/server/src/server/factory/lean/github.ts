import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  createObservedSubmission,
  type ObservedSubmissionOptions,
} from "./machines/observed-submission.js";
import { hostPlanRevision, type HostSubmissionProof } from "./review-evidence.js";
import { z } from "zod";
import {
  createMachineLeasePort,
  createUnsignedHostLeasePort,
  type ClaimSnapshot,
  type MachineClaimOptions,
  type MachineLeasePort,
} from "./machines/claims.js";
import {
  claimIssue,
  FactoryGitHubError,
  markerInstallations,
  OWNER_ONLY_FILES,
  ownerOnlyChanges,
  type FactoryGitHub,
} from "../project/claims.js";
import type { ClaimState } from "../project/state.js";
import {
  issueBrief,
  issueTrust,
  readIssueFacts,
  readTrustedAccounts,
  type TrustedAccounts,
} from "../project/trust.js";
import type { ForeignMergeReview, MergeEvidence, MergeGateDeps } from "./merge-gate.js";
import type { HostedGateState, IssueGateInputs } from "./gate-runtime.js";
import {
  LEAN_PROTOCOL_MAJOR,
  type AdmissionFacts,
  type GitHubFacts,
  type Lease,
  type LeasePort,
  type PullFacts,
  type PullRef,
} from "./types.js";

export type LeanGitHubApproval = Pick<
  Extract<MergeEvidence, { kind: "open" }>,
  | "lead"
  | "reviewer"
  | "verdict"
  | "acceptance"
  | "acceptanceSession"
  | "reviewPolicy"
  | "foreignReview"
>;

type Completion = Parameters<MergeGateDeps["complete"]>[0];
type ExpectedSubmission = ForeignMergeReview["submission"];

function matchesSubmission(claim: ClaimSnapshot | null, expected: ExpectedSubmission): boolean {
  const record = claim?.record;
  return (
    record?.installation === expected.installation &&
    record.generation === expected.generation &&
    record.submission?.head === expected.head &&
    record.submission.builderProviderType === expected.builderProviderType
  );
}

export interface LeanGitHubOptions<
  Approval extends LeanGitHubApproval = LeanGitHubApproval,
> extends Pick<
  MergeGateDeps,
  "here" | "currentMergeEpoch" | "fenceMerge" | "readIntent" | "recordIntent"
> {
  github: FactoryGitHub;
  repository: string;
  now(): Date;
  leaseTtlMs: number;
  machineClaims?: Pick<MachineClaimOptions, "refs" | "sign" | "verify" | "isPrimary">;
  hostDispatch?: Pick<MachineClaimOptions, "refs" | "isPrimary">;
  hostSourceForHead?: ObservedSubmissionOptions["sourceForHead"];
  readApprovedForeignPlan?(
    issue: number,
    plan: NonNullable<AdmissionFacts["plan"]>,
  ): Promise<boolean>;
  pushSavedMachineWork?: MachineClaimOptions["pushSavedWork"];
  mergeMethod?: "MERGE" | "SQUASH" | "REBASE";
  extraChecks?: readonly string[];
  requiredChecks?: readonly string[];
  scopeIssue?: number;
  /** Resolved from the trusted default branch, including the release recipe's file inputs. */
  releaseRecipeFiles(): Promise<readonly string[]>;
  reportProtectedChange(issue: number, paths: readonly string[]): Promise<void>;
  readClaim(issue: number): Promise<ClaimState | undefined>;
  writeClaim(issue: number, claim: ClaimState | undefined): Promise<void>;
  readApproval(issue: number, headSha: string): Promise<Approval>;
  readGo(issue: number, plan: NonNullable<AdmissionFacts["plan"]>): Promise<AdmissionFacts["go"]>;
  /** Durable idempotent acknowledgement of the verified merge before closing the issue. */
  recordMerge(completion: Completion): ReturnType<MergeGateDeps["complete"]>;
}

interface MergedPull {
  issue: number;
  pr: PullRef;
  mergeSha: string;
}

export interface LeanGitHubFacts extends GitHubFacts {
  merged: MergedPull[];
}

export interface LeanGitHub {
  verifyHostSubmission(input: {
    issue: number;
    pullNumber: number;
    head: string;
  }): Promise<HostSubmissionProof | null>;
  readForeignPlan(issue: number): Promise<AdmissionFacts["plan"]>;
  readFacts(trackedIssues?: readonly number[]): Promise<LeanGitHubFacts>;
  readIssueGateInputs(issue: number, head: string): Promise<IssueGateInputs | null>;
  gateDeps: MergeGateDeps;
  lease: LeasePort;
  machineLease?: MachineLeasePort;
}

const oid = z.string().regex(/^[0-9a-f]{40}$/);
const timestamp = z.string().datetime({ offset: true });
const label = z.object({ name: z.string() });
const issueSummary = z.object({
  number: z.number().int().positive(),
  node_id: z.string(),
  state: z.enum(["open", "closed"]),
  updated_at: timestamp,
  labels: z.array(label),
  pull_request: z.unknown().optional(),
});
const comment = z.object({
  id: z.number().int().positive(),
  node_id: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  updated_at: timestamp,
  user: z.object({ login: z.string() }).nullable(),
});
type Comment = z.infer<typeof comment>;
const repoName = z.object({ full_name: z.string() });
const restPull = z.object({
  number: z.number().int().positive(),
  node_id: z.string(),
  head: z.object({ ref: z.string(), sha: oid, repo: repoName.nullable() }),
  base: z.object({ ref: z.string(), repo: repoName, sha: oid.optional() }),
  state: z.enum(["open", "closed"]),
  labels: z.array(label),
});
const pullDetail = restPull.extend({
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  merged: z.boolean(),
  merge_commit_sha: oid.nullable(),
  changed_files: z.number().int().nonnegative(),
});
type PullDetail = z.infer<typeof pullDetail>;
const repositoryData = z.object({
  repository: z.object({
    defaultBranchRef: z.object({
      name: z.string(),
      target: z.object({ oid }),
      branchProtectionRule: z
        .object({ requiredStatusCheckContexts: z.array(z.string()).nullable() })
        .nullable(),
    }),
    mergeQueue: z.object({ id: z.string() }).nullable(),
    mergeCommitAllowed: z.boolean(),
    squashMergeAllowed: z.boolean(),
    rebaseMergeAllowed: z.boolean(),
  }),
  viewer: z.object({ login: z.string() }),
});
type Repository = z.infer<typeof repositoryData>["repository"];
const repositoryQuery = `query($owner:String!,$name:String!) {
  viewer { login }
  repository(owner:$owner,name:$name) {
    defaultBranchRef { name target { oid } branchProtectionRule { requiredStatusCheckContexts } }
    mergeQueue { id }
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
  }
}`;
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const checkContext = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    name: z.string(),
    isRequired: z.boolean(),
    status: z.string(),
    conclusion: z.string().nullable(),
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    name: z.string(),
    isRequired: z.boolean(),
    state: z.string(),
  }),
]);
type CheckContext = z.infer<typeof checkContext>;
const checkQuery = `query($owner:String!,$name:String!,$sha:GitObjectID!,$pr:ID!,$cursor:String) {
  repository(owner:$owner,name:$name) {
    object(oid:$sha) { ... on Commit { oid statusCheckRollup {
      contexts(first:100,after:$cursor) { pageInfo { hasNextPage endCursor } nodes {
        __typename
        ... on CheckRun { name isRequired(pullRequestId:$pr) status conclusion }
        ... on StatusContext { name:context isRequired(pullRequestId:$pr) state }
      } }
    } } }
  }
}`;
const checkData = z.object({
  repository: z.object({
    object: z.object({
      oid,
      statusCheckRollup: z
        .object({ contexts: z.object({ pageInfo, nodes: z.array(checkContext) }) })
        .nullable(),
    }),
  }),
});
const threadQuery = `query($pr:ID!,$cursor:String) {
  node(id:$pr) { ... on PullRequest {
    headRefOid mergeStateStatus mergeQueueEntry { id }
    reviewThreads(first:100,after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { isResolved comments(first:1) { nodes { author { login } } } }
    }
  } }
}`;
const threadData = z.object({
  node: z.object({
    headRefOid: oid,
    mergeStateStatus: z.string(),
    mergeQueueEntry: z.object({ id: z.string() }).nullable(),
    reviewThreads: z.object({
      pageInfo,
      nodes: z.array(
        z.object({
          isResolved: z.boolean(),
          comments: z.object({
            nodes: z.array(z.object({ author: z.object({ login: z.string() }).nullable() })),
          }),
        }),
      ),
    }),
  }),
});
const rule = z.object({ type: z.string(), parameters: z.unknown().optional() });
const requiredRule = z.object({
  required_status_checks: z.array(z.object({ context: z.string() })),
});
const file = z.object({ filename: z.string(), previous_filename: z.string().optional() });
const leasePattern =
  /^<!-- factory-lease v1 installation=(\S+) protocol=(\d+) expires=(\S+?)(?: released=(\S+))? -->$/m;
const ownerOnlyPaths = new Set([...OWNER_ONLY_FILES, ".github/vorteo-factory.json"]);
const gateConfig = z.looseObject({
  schema: z.literal("vorteo-factory"),
  version: z.literal(1),
  issueGates: z
    .array(
      z.object({
        argv: z.array(z.string().min(1)).min(1),
        where: z.enum(["container", "host"]).default("container"),
        requiredOutput: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .optional(),
  checks: z.array(z.string().min(1)).optional(),
  releaseRecipeFiles: z.array(z.string().min(1)).optional(),
});
const treeEntries = z.object({
  sha: oid,
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: oid })),
});

function pinnedTreeEntry(tree: z.infer<typeof treeEntries>, path: string) {
  const matches = tree.tree.filter((entry) => entry.path === path);
  if (matches.length > 1)
    throw new FactoryGitHubError("The owner configuration path is ambiguous.");
  return matches[0];
}

function protectedChanges(paths: readonly string[], recipeFiles: readonly string[]): string[] {
  return paths.filter(
    (path) =>
      ownerOnlyPaths.has(path) ||
      path.startsWith(".github/workflows/") ||
      recipeFiles.includes(path),
  );
}

function checkState(context: CheckContext): PullRef["checks"] {
  if (context.__typename === "StatusContext") {
    if (context.state === "SUCCESS") return "passing";
    if (context.state === "ERROR" || context.state === "FAILURE") return "failing";
    return "pending";
  }
  if (context.status !== "COMPLETED" || context.conclusion === null) return "pending";
  return context.conclusion === "SUCCESS" ? "passing" : "failing";
}

function latestPlan(
  comments: Comment[],
  installation: string,
  branch: string,
  bindContents = false,
): AdmissionFacts["plan"] {
  const newest = comments.toReversed();
  for (const entry of newest) {
    const body = entry.body ?? "";
    if (!markerInstallations(body, branch).includes(installation)) continue;
    if (!/^(?:#{1,6}\s+)?Resolution plan\s*$/im.test(body)) continue;
    const section =
      /^(?:#{1,6}[ \t]+)?Files[ \t]*:?[ \t]*\r?\n([\s\S]*?)(?=^#{1,6}[ \t]|^[ \t]*(?:Approach|Tests|Risks|Out of scope|Heavy):|(?![\s\S]))/im.exec(
        body,
      );
    if (!section?.[1]) return null;
    const rows = section[1]
      .trim()
      .split(/\r?\n[ \t]*\r?\n/u, 1)[0]
      .split(/\r?\n/)
      .filter((line) => line.trim());
    const files = rows.map((line) =>
      line
        .trim()
        .replace(/^[-*]\s+/, "")
        .replace(/^`([^`]+)`$/, "$1"),
    );
    if (
      !files.length ||
      files.some((path) => !/^[\w.@+-][\w.@+/-]*$/.test(path) || path.split("/").includes(".."))
    ) {
      return null;
    }
    return {
      commentId: entry.id,
      ...(bindContents && { contentDigest: createHash("sha256").update(body).digest("hex") }),
      files: [...new Set(files)],
      heavy: /^Heavy:\s*yes\s*$/im.test(body),
      postedAt: entry.updated_at,
    };
  }
  return null;
}

export function createLeanGitHub<Approval extends LeanGitHubApproval>(
  options: LeanGitHubOptions<Approval>,
): LeanGitHub {
  const { github, here, repository } = options;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !Number.isSafeInteger(options.leaseTtlMs) ||
    options.leaseTtlMs <= 0
  ) {
    throw new FactoryGitHubError(
      "Configure a GitHub repository and a positive Factory lease duration.",
    );
  }
  const [owner, name] = repository.split("/");
  const scope = { owner, name };
  const root = `repos/${repository}`;
  const branch = (issue: number) => `factory/issue-${issue}`;
  const knownLeases = new Map<number, { revision: string; seenAt: string }>();

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await github.rest("GET", `${root}/${path}`);
    if (
      path.startsWith("rules/branches/") &&
      response.status === 403 &&
      typeof response.body === "object" &&
      response.body &&
      "message" in response.body &&
      typeof response.body.message === "string" &&
      /upgrade to github pro or make this repository public/i.test(response.body.message)
    ) {
      return schema.parse([]);
    }
    if (response.status !== 200)
      throw new FactoryGitHubError(
        `GitHub refused a Factory repository read (HTTP ${response.status}).`,
      );
    return schema.parse(response.body);
  }

  async function graph<T>(query: string, variables: object, schema: z.ZodType<T>): Promise<T> {
    const response = await github.rest("POST", "graphql", { query, variables });
    const envelope = z
      .object({ data: z.unknown(), errors: z.array(z.unknown()).default([]) })
      .parse(response.body);
    if (response.status !== 200 || envelope.errors.length) {
      throw new FactoryGitHubError("GitHub refused a Factory GraphQL operation.");
    }
    return schema.parse(envelope.data);
  }

  async function pages<T>(path: string, schema: z.ZodType<T>, limit = 1000): Promise<T[]> {
    const result: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; ; page++) {
      const rows = await get(`${path}${separator}per_page=100&page=${page}`, z.array(schema));
      result.push(...rows);
      if (rows.length < 100) return result;
      if (result.length >= limit)
        throw new FactoryGitHubError("GitHub returned a partial Factory evidence list.");
    }
  }

  async function trustedComments(issue: number, trusted: TrustedAccounts): Promise<Comment[]> {
    const comments = await pages(`issues/${issue}/comments`, comment);
    const accepted: Comment[] = [];
    for (const entry of comments) if (await trusted(entry.user?.login)) accepted.push(entry);
    return accepted;
  }

  function parseLeases(issue: number, comments: Comment[]): { lease: Lease; comment: Comment }[] {
    const byInstallation = new Map<string, { lease: Lease; comment: Comment }>();
    for (const entry of comments) {
      const parsed = leasePattern.exec(entry.body ?? "");
      if (!parsed) continue;
      const [, installation, version, expiresAt, released] = parsed;
      const valid = z
        .object({
          installation: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
          protocol: z.number().int().positive(),
          expiresAt: timestamp,
          released: timestamp.optional(),
        })
        .safeParse({ installation, protocol: Number(version), expiresAt, released });
      if (!valid.success) continue;
      const revision = `${entry.updated_at}/${entry.body}`;
      let observed = knownLeases.get(entry.id);
      if (observed?.revision !== revision) {
        observed = { revision, seenAt: options.now().toISOString() };
        knownLeases.set(entry.id, observed);
      }
      byInstallation.set(valid.data.installation, {
        comment: entry,
        lease: {
          issue,
          branch: branch(issue),
          installation: valid.data.installation,
          protocol: valid.data.protocol,
          expiresAt: valid.data.expiresAt,
          renewedAt: entry.updated_at,
          seenUnchangedSince: observed.seenAt,
          released: valid.data.released !== undefined,
        },
      });
    }
    return [...byInstallation.values()];
  }

  function activeLease(lease: Lease, now: Date): boolean {
    const deadline =
      lease.installation === here
        ? Date.parse(lease.expiresAt)
        : Date.parse(lease.seenUnchangedSince) + options.leaseTtlMs;
    return !lease.released && deadline > now.getTime();
  }

  async function readBranch(issue: number): Promise<string | null> {
    const response = await github.rest("GET", `${root}/git/ref/heads/${branch(issue)}`);
    if (response.status === 404) return null;
    if (response.status !== 200)
      throw new FactoryGitHubError("GitHub refused to verify the claim branch.");
    return z.object({ object: z.object({ sha: oid }) }).parse(response.body).object.sha;
  }

  async function candidates(issue: number, repo: Repository): Promise<PullDetail[]> {
    const head = encodeURIComponent(`${owner}:${branch(issue)}`);
    const base = encodeURIComponent(repo.defaultBranchRef.name);
    const listed = await pages(`pulls?state=all&head=${head}&base=${base}`, restPull);
    const matching = listed.filter(
      (pull) =>
        pull.head.ref === branch(issue) &&
        pull.head.repo?.full_name.toLowerCase() === repository.toLowerCase() &&
        pull.base.repo.full_name.toLowerCase() === repository.toLowerCase() &&
        pull.base.ref === repo.defaultBranchRef.name,
    );
    return Promise.all(matching.map((pull) => get(`pulls/${pull.number}`, pullDetail)));
  }

  function pullRef(
    pull: PullDetail,
    repo: Repository,
    status: PullRef["checks"],
  ): Extract<MergeEvidence, { kind: "open" }>["pull"] {
    return {
      number: pull.number,
      headSha: pull.head.sha,
      branch: pull.head.ref,
      sameRepo: pull.head.repo?.full_name.toLowerCase() === repository.toLowerCase(),
      targetsDefaultBranch:
        pull.base.ref === repo.defaultBranchRef.name &&
        pull.base.repo.full_name.toLowerCase() === repository.toLowerCase(),
      checks: status,
    };
  }

  async function mergedPull(pull: PullDetail, repo: Repository): Promise<MergeEvidence> {
    const mergeSha = pull.merge_commit_sha;
    if (!mergeSha)
      return { kind: "unavailable", reason: "GitHub has not reported the merge commit." };
    const baseSha = repo.defaultBranchRef.target.oid;
    if (mergeSha !== baseSha) {
      const comparison = await get(
        `compare/${mergeSha}...${baseSha}?per_page=1`,
        z.object({
          status: z.string(),
          merge_base_commit: z.object({ sha: oid }),
        }),
      );
      if (comparison.status !== "ahead" || comparison.merge_base_commit.sha !== mergeSha) {
        return {
          kind: "unavailable",
          reason: "The recorded merge is absent from the current default branch.",
        };
      }
    }
    return { kind: "merged", pull: pullRef(pull, repo, "pending"), mergeSha };
  }

  async function reviewThreads(pull: PullDetail, trusted: TrustedAccounts) {
    let cursor: string | null = null;
    let open = 0;
    for (;;) {
      const data: z.infer<typeof threadData> = await graph(
        threadQuery,
        { pr: pull.node_id, cursor },
        threadData,
      );
      const state = data.node;
      if (state.headRefOid !== pull.head.sha)
        throw new FactoryGitHubError("The pull request moved while Factory read review threads.");
      for (const thread of state.reviewThreads.nodes) {
        if (!thread.isResolved && (await trusted(thread.comments.nodes[0]?.author?.login))) open++;
      }
      if (!state.reviewThreads.pageInfo.hasNextPage) return { open, state };
      const next = state.reviewThreads.pageInfo.endCursor;
      if (!next || next === cursor)
        throw new FactoryGitHubError("GitHub did not finish listing review threads.");
      cursor = next;
    }
  }

  async function requiredChecks(repo: Repository): Promise<Set<string>> {
    const names = new Set(
      repo.defaultBranchRef.branchProtectionRule?.requiredStatusCheckContexts ?? [],
    );
    const rules = await pages(
      `rules/branches/${encodeURIComponent(repo.defaultBranchRef.name)}`,
      rule,
    );
    for (const item of rules) {
      if (item.type !== "required_status_checks") continue;
      const parameters = requiredRule.parse(item.parameters);
      for (const check of parameters.required_status_checks) names.add(check.context);
    }
    return names;
  }

  async function* headCheckContexts(pull: PullDetail): AsyncGenerator<CheckContext> {
    let cursor: string | null = null;
    for (;;) {
      const data: z.infer<typeof checkData> = await graph(
        checkQuery,
        { ...scope, sha: pull.head.sha, pr: pull.node_id, cursor },
        checkData,
      );
      const commit = data.repository.object;
      if (commit.oid !== pull.head.sha)
        throw new FactoryGitHubError("GitHub returned checks for another commit.");
      const contexts = commit.statusCheckRollup?.contexts;
      if (!contexts) break;
      yield* contexts.nodes;
      if (!contexts.pageInfo.hasNextPage) break;
      const next = contexts.pageInfo.endCursor;
      if (!next || next === cursor)
        throw new FactoryGitHubError("GitHub did not finish listing commit checks.");
      cursor = next;
    }
  }

  async function hostedChecks(
    pull: PullDetail,
    repo: Repository,
    configuredChecks: readonly string[],
  ): Promise<HostedGateState> {
    const names = await requiredChecks(repo);
    const configured = new Set(configuredChecks);
    for (const checkName of configured) names.add(checkName);
    const extra = new Set(options.extraChecks ?? []);
    let pending = false;
    let observed = false;
    let anyContext = extra.size > 0;
    for await (const context of headCheckContexts(pull)) {
      anyContext = true;
      const required = context.isRequired || configured.has(context.name);
      if (required) names.delete(context.name);
      if (!required && !extra.has(context.name)) continue;
      observed = true;
      const result = checkState(context);
      if (result === "failing") return "failing";
      if (required && result === "pending") pending = true;
    }
    if (pending || names.size > 0) return "pending";
    if (observed) return "passing";
    return anyContext ? "pending" : "absent";
  }

  async function filePaths(pull: PullDetail): Promise<string[]> {
    const entries = await pages(`pulls/${pull.number}/files`, file, 3000);
    if (entries.length !== pull.changed_files)
      throw new FactoryGitHubError("GitHub did not return the complete pull request diff.");
    return [
      ...new Set(
        entries.flatMap((entry) =>
          entry.previous_filename ? [entry.filename, entry.previous_filename] : [entry.filename],
        ),
      ),
    ];
  }

  async function inspectOpen(
    pull: PullDetail,
    repo: Repository,
    trusted: TrustedAccounts,
    configuredChecks = options.requiredChecks ?? [],
  ) {
    const threads = await reviewThreads(pull, trusted);
    if (threads.state.mergeQueueEntry) {
      return { kind: "queued" as const, pull: pullRef(pull, repo, "pending") };
    }
    const [files, status] = await Promise.all([
      filePaths(pull),
      hostedChecks(pull, repo, configuredChecks),
    ]);
    const after = await get(`pulls/${pull.number}`, pullDetail);
    if (
      after.head.sha !== pull.head.sha ||
      after.base.ref !== pull.base.ref ||
      after.base.sha !== pull.base.sha ||
      after.changed_files !== pull.changed_files ||
      after.state !== "open"
    ) {
      throw new FactoryGitHubError(
        "The pull request changed while Factory checked its files and checks.",
      );
    }
    const permissible = ["CLEAN", "UNSTABLE"].includes(threads.state.mergeStateStatus);
    return {
      kind: "open" as const,
      pull: pullRef(after, repo, status === "absent" ? "pending" : status),
      hostedChecks: status,
      draft: after.draft,
      files,
      trustedThreadsOpen: threads.open,
      mergeable: after.mergeable === null ? null : after.mergeable && !after.draft && permissible,
      labels: after.labels.map((entry) => entry.name),
    };
  }

  async function readIssue(issue: number, trusted: TrustedAccounts) {
    const before = await get(`issues/${issue}`, issueSummary);
    const [facts, comments] = await Promise.all([
      readIssueFacts(github, repository, issue),
      trustedComments(issue, trusted),
    ]);
    const summary = await get(`issues/${issue}`, issueSummary);
    if (before.updated_at !== summary.updated_at) {
      throw new FactoryGitHubError("The issue changed while Factory read its approval history.");
    }
    if (summary.number !== issue || facts.number !== issue || summary.pull_request !== undefined) {
      throw new FactoryGitHubError("GitHub did not return the requested Factory issue.");
    }
    const labels = summary.labels.map((entry) => entry.name);
    const trust = labels.includes("factory:ready")
      ? await issueTrust(facts, trusted)
      : { trusted: false as const, reason: "Apply the Factory ready label to the approved issue." };
    return { facts, summary, comments, labels, trust, leases: parseLeases(issue, comments) };
  }

  function findOpen(pulls: PullDetail[]): PullDetail | null {
    const open = pulls.filter((pull) => pull.state === "open");
    if (open.length > 1)
      throw new FactoryGitHubError(
        "More than one open pull request uses the Factory claim branch.",
      );
    return open[0] ?? null;
  }

  async function findMerged(issue: number, pulls: PullDetail[]): Promise<PullDetail | null> {
    const merged = pulls.filter((pull) => pull.merged);
    if (merged.length <= 1) return merged[0] ?? null;
    const withIntent: PullDetail[] = [];
    for (const pull of merged) {
      const intent = await options.readIntent({
        issue,
        number: pull.number,
        headSha: pull.head.sha,
      });
      if (intent) withIntent.push(pull);
    }
    if (withIntent.length !== 1)
      throw new FactoryGitHubError(
        "Resolve the conflicting merged pull requests on the Factory claim branch.",
      );
    return withIntent[0] ?? null;
  }

  async function readGate(issue: number): Promise<MergeEvidence> {
    const [{ repository: repo, viewer }, trusted] = await Promise.all([
      graph(repositoryQuery, scope, repositoryData),
      readTrustedAccounts(github, repository),
    ]);
    const pulls = await candidates(issue, repo);
    const open = findOpen(pulls);
    if (!open) {
      const merged = await findMerged(issue, pulls);
      if (merged) return mergedPull(merged, repo);
      return { kind: "unavailable", reason: "Open a pull request from the Factory claim branch." };
    }
    const [inspected, issueData, head] = await Promise.all([
      inspectOpen(open, repo, trusted),
      readIssue(issue, trusted),
      readBranch(issue),
    ]);
    if (inspected.kind === "queued") return inspected;
    const current = issueData.leases.filter(({ lease }) => activeLease(lease, options.now()));
    const single = current.length === 1 ? current[0] : undefined;
    let lease =
      single && head === inspected.pull.headSha && single.lease.protocol === LEAN_PROTOCOL_MAJOR
        ? single.lease
        : null;
    if (machineLease) {
      lease = await machineGateLease(issue, inspected.pull.headSha, head);
    } else if (lease?.installation === here) {
      const claim = await options.readClaim(issue);
      const ownsLease = ownLease(current, viewer.login);
      if (claim?.status !== "held" || claim.branch !== lease.branch || !ownsLease) lease = null;
    }
    const protectedPaths = protectedChanges(inspected.files, await options.releaseRecipeFiles());
    if (protectedPaths.length) await options.reportProtectedChange(issue, protectedPaths);
    const approval = await options.readApproval(issue, inspected.pull.headSha);
    if (!(await validateForeignApproval(issue, inspected.pull.headSha, approval))) {
      return {
        kind: "unavailable",
        reason: "The primary could not revalidate the foreign review target.",
      };
    }
    const blocked =
      issueData.summary.state !== "open" ||
      issueData.labels.includes("factory:blocked") ||
      inspected.labels.includes("factory:blocked");
    return {
      ...approval,
      kind: "open",
      pull: inspected.pull,
      trust: issueData.trust,
      blocked,
      lease,
      ownerOnly: {
        checkedHeadSha: inspected.pull.headSha,
        touched: protectedPaths,
      },
      checksHeadSha: inspected.pull.headSha,
      trustedThreadsOpen: inspected.trustedThreadsOpen,
      mergeable: inspected.mergeable,
    };
  }

  async function readPinnedGateConfig(
    configCommit: string,
  ): Promise<z.infer<typeof gateConfig> | null> {
    const commit = await get(
      `git/commits/${configCommit}`,
      z.object({ sha: z.literal(configCommit), tree: z.object({ sha: oid }) }),
    );
    const rootTree = await get(`git/trees/${commit.tree.sha}`, treeEntries);
    if (rootTree.sha !== commit.tree.sha)
      throw new FactoryGitHubError("GitHub returned the wrong configuration tree.");
    const directory = pinnedTreeEntry(rootTree, ".github");
    if (!directory) return null;
    if (directory.type !== "tree" || directory.mode !== "040000")
      throw new FactoryGitHubError("The owner configuration directory must be a Git tree.");
    const tree = await get(`git/trees/${directory.sha}`, treeEntries);
    if (tree.sha !== directory.sha)
      throw new FactoryGitHubError("GitHub returned the wrong owner configuration directory.");
    const entry = pinnedTreeEntry(tree, "vorteo-factory.json");
    if (!entry) return null;
    if (entry.type !== "blob" || entry.mode !== "100644")
      throw new FactoryGitHubError(
        "The owner recipe must be a regular file on the default branch.",
      );
    const blob = await get(
      `git/blobs/${entry.sha}`,
      z.object({ sha: z.literal(entry.sha), encoding: z.literal("base64"), content: z.string() }),
    );
    const bytes = Buffer.from(blob.content, "base64");
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (sha !== entry.sha)
      throw new FactoryGitHubError("GitHub returned the wrong owner recipe bytes.");
    return gateConfig.parse(JSON.parse(bytes.toString("utf8")));
  }

  function observedPull(
    issue: number,
    open: PullDetail,
    inspected: Extract<Awaited<ReturnType<typeof inspectOpen>>, { kind: "open" }>,
    repo: Repository,
    config: z.infer<typeof gateConfig> | null,
    data: Awaited<ReturnType<typeof readIssue>>,
    branchHead: string,
  ) {
    const head = open.head.sha;
    const configCommit = repo.defaultBranchRef.target.oid;
    return config && open.base.sha && open.head.repo
      ? {
          issue,
          pullNumber: open.number,
          state: open.state,
          draft: inspected.draft,
          headRepository: open.head.repo.full_name,
          baseRepository: open.base.repo.full_name,
          headBranch: open.head.ref,
          baseBranch: open.base.ref,
          defaultBranch: repo.defaultBranchRef.name,
          headSha: head,
          branchHeadSha: branchHead,
          baseSha: open.base.sha,
          defaultHeadSha: configCommit,
          trusted: data.trust.trusted,
          blocked:
            data.summary.state !== "open" ||
            data.labels.includes("factory:blocked") ||
            inspected.labels.includes("factory:blocked"),
          // inspectOpen checks changed_files and includes both names for every rename.
          filesComplete: true,
          files: inspected.files.map((path) => ({ path })),
          protectedPaths: [...ownerOnlyPaths, ...(config.releaseRecipeFiles ?? [])],
        }
      : null;
  }

  function matchesCurrentPull(
    inspected: Awaited<ReturnType<typeof inspectOpen>>,
    head: string,
  ): inspected is Extract<Awaited<ReturnType<typeof inspectOpen>>, { kind: "open" }> {
    return (
      inspected.kind === "open" &&
      !inspected.draft &&
      inspected.pull.headSha === head &&
      inspected.pull.sameRepo &&
      inspected.pull.targetsDefaultBranch
    );
  }

  async function readIssueGateInputs(issue: number, expectedHead?: string) {
    if (options.scopeIssue !== undefined && options.scopeIssue !== issue) return null;
    const [{ repository: repo, viewer }, trusted] = await Promise.all([
      graph(repositoryQuery, scope, repositoryData),
      readTrustedAccounts(github, repository),
    ]);
    const configCommit = repo.defaultBranchRef.target.oid;
    const [config, pulls, data] = await Promise.all([
      readPinnedGateConfig(configCommit),
      candidates(issue, repo),
      readIssue(issue, trusted),
    ]);
    const open = findOpen(pulls);
    if (!open || (expectedHead !== undefined && open.head.sha !== expectedHead) || open.draft)
      return null;
    const head = open.head.sha;
    const inspected = await inspectOpen(open, repo, trusted, config?.checks ?? []);
    if (!matchesCurrentPull(inspected, head)) return null;
    const [branchHead, claim, { repository: current }] = await Promise.all([
      readBranch(issue),
      machineLease ? undefined : options.readClaim(issue),
      graph(repositoryQuery, scope, repositoryData),
    ]);
    if (
      current.defaultBranchRef.target.oid !== configCommit ||
      current.defaultBranchRef.name !== repo.defaultBranchRef.name ||
      branchHead !== head
    )
      return null;
    return {
      issue,
      repository,
      head,
      configCommit,
      observation: observedPull(issue, open, inspected, repo, config, data, branchHead),
      trustedThreadsOpen: inspected.trustedThreadsOpen,
      mergeable: inspected.mergeable,
      commands: config?.issueGates ?? [],
      hostedChecks: inspected.hostedChecks,
      trusted: await trustedGateClaim({
        issue,
        data,
        pullLabels: inspected.labels,
        claim,
        viewer: viewer.login,
        head,
      }),
      protectedPaths: protectedChanges(inspected.files, config?.releaseRecipeFiles ?? []),
    };
  }

  async function trustedGateClaim(input: {
    issue: number;
    data: Awaited<ReturnType<typeof readIssue>>;
    pullLabels: string[];
    claim: ClaimState | undefined;
    viewer: string;
    head: string;
  }): Promise<boolean> {
    const { issue, data, pullLabels, claim, viewer, head } = input;
    const admitted =
      data.summary.state === "open" &&
      data.trust.trusted &&
      !data.labels.includes("factory:blocked") &&
      !pullLabels.includes("factory:blocked");
    if (!admitted) return false;
    if (machineLease) return Boolean(await machineGateLease(issue, head, await readBranch(issue)));
    const active = data.leases.filter(({ lease }) => activeLease(lease, options.now()));
    return (
      active.length === 1 &&
      Boolean(ownLease(active, viewer)) &&
      claim?.status === "held" &&
      claim.branch === branch(issue)
    );
  }

  async function machineGateLease(
    issue: number,
    head: string,
    branchHead: string | null,
  ): Promise<Lease | null> {
    if (!machineLease || branchHead !== head) return null;
    const lease = await machineLease.readLease(issue);
    if (!lease || lease.released || Date.parse(lease.expiresAt) <= options.now().getTime())
      return null;
    if (lease.installation === here || options.hostDispatch) return lease;
    const signed = await machineLease.readSubmission(issue, head);
    return signed?.record.installation === lease.installation ? lease : null;
  }

  async function recheckForeignSubmission(
    issue: number,
    head: string,
    expected: ExpectedSubmission,
  ): Promise<boolean> {
    if (!machineLease || expected.installation === here || expected.head !== head) return false;
    return matchesSubmission(await machineLease.readSubmission(issue, head), expected);
  }

  async function validateForeignApproval(
    issue: number,
    head: string,
    approval: LeanGitHubApproval,
  ) {
    const hostProof = approval.foreignReview?.hostProof;
    if (hostProof)
      return (
        hostProof.issue === issue && hostProof.head === head && (await sameHostProof(hostProof))
      );
    const expected = approval.foreignReview?.submission;
    return !expected || recheckForeignSubmission(issue, head, expected);
  }

  async function writeLease(
    issue: number,
    previous: Comment | null,
    release: boolean,
  ): Promise<Lease> {
    const now = options.now();
    const expires = new Date(now.getTime() + options.leaseTtlMs).toISOString();
    const releasedAt = release ? ` released=${now.toISOString()}` : "";
    const body = [
      "(AI Generated)",
      "",
      `<!-- factory-lease v1 installation=${here} protocol=${LEAN_PROTOCOL_MAJOR} expires=${expires}${releasedAt} -->`,
      release ? "Factory released the issue lease." : "Factory holds the issue lease.",
    ].join("\n");
    let saved: Comment;
    if (previous) {
      await graph(
        `mutation($id:ID!,$body:String!) { updateIssueComment(input:{id:$id,body:$body}) { issueComment { id } } }`,
        { id: previous.node_id, body },
        z.object({
          updateIssueComment: z.object({
            issueComment: z.object({ id: z.literal(previous.node_id) }),
          }),
        }),
      );
      saved = await get(`issues/comments/${previous.id}`, comment);
    } else {
      const response = await github.rest("POST", `${root}/issues/${issue}/comments`, { body });
      if (response.status !== 201)
        throw new FactoryGitHubError("GitHub refused to write the Factory lease.");
      saved = comment.parse(response.body);
    }
    const observed = parseLeases(issue, [saved])[0];
    if (saved.body !== body || !observed)
      throw new FactoryGitHubError("GitHub did not confirm the Factory lease update.");
    return observed.lease;
  }

  function ownLease(
    entries: ReturnType<typeof parseLeases>,
    viewer: string,
  ): ReturnType<typeof parseLeases>[number] | undefined {
    return entries.find(
      ({ lease, comment: entry }) =>
        lease.installation === here &&
        lease.protocol === LEAN_PROTOCOL_MAJOR &&
        entry.user?.login.toLowerCase() === viewer.toLowerCase(),
    );
  }

  async function readLeaseContext(issue: number) {
    const [trusted, repo] = await Promise.all([
      readTrustedAccounts(github, repository),
      graph(repositoryQuery, scope, repositoryData),
    ]);
    if (!(await trusted(repo.viewer.login)))
      throw new FactoryGitHubError("Connect a GitHub account trusted by this Factory repository.");
    const data = await readIssue(issue, trusted);
    const own = ownLease(data.leases, repo.viewer.login);
    return { ...data, trusted, repo: repo.repository, own, viewer: repo.viewer.login };
  }

  async function prepareClaim(
    issue: number,
    data: Awaited<ReturnType<typeof readLeaseContext>>,
  ): ReturnType<MachineClaimOptions["prepare"]> {
    const { trust, summary, labels } = data;
    if (!trust.trusted) return { outcome: "refused", code: "untrusted", reason: trust.reason };
    if (summary.state !== "open" || labels.includes("factory:blocked")) {
      return {
        outcome: "refused",
        code: "blocked",
        reason: "Resolve the Factory block and open the issue before claiming it.",
      };
    }
    const diff = await ownerOnlyChanges(github, repository, issue);
    const pull = findOpen(await candidates(issue, data.repo));
    const paths = pull ? await filePaths(pull) : [];
    const protectedPaths = [
      ...new Set([...diff.touched, ...protectedChanges(paths, await options.releaseRecipeFiles())]),
    ];
    if (protectedPaths.length) {
      await options.reportProtectedChange(issue, protectedPaths);
      return {
        outcome: "refused",
        code: "owner-only",
        reason: "Remove the owner-only changes before claiming this issue.",
      };
    }
    if (pull) {
      const after = await get(`pulls/${pull.number}`, pullDetail);
      if (
        after.head.sha !== diff.checkedHeadSha ||
        after.head.sha !== pull.head.sha ||
        after.state !== "open"
      ) {
        return {
          outcome: "refused",
          code: "head-moved",
          reason: "Recheck the pull request after its head settles.",
        };
      }
    }
    return {
      brief: await issueBrief(data.facts, data.trusted),
      checkedHeadSha: diff.checkedHeadSha,
    };
  }

  const leaseInputs: Omit<MachineClaimOptions, "refs" | "sign" | "verify" | "isPrimary"> = {
    repository,
    installation: here,
    now: options.now,
    prepare: async (issue) => prepareClaim(issue, await readLeaseContext(issue)),
    readWorkHead: readBranch,
    async ensureWorkBranch(issue) {
      const { repository: repo } = await graph(repositoryQuery, scope, repositoryData);
      const ref = "refs/heads/" + branch(issue);
      const response = await github.rest("POST", root + "/git/refs", {
        ref,
        sha: repo.defaultBranchRef.target.oid,
      });
      if (response.status !== 201 && !(response.status === 422 && (await readBranch(issue))))
        throw new FactoryGitHubError("Factory could not create the issue branch.");
    },
    async pushSavedWork(issue, expected) {
      if (!options.pushSavedMachineWork)
        throw new Error("Save the Builder work before releasing the claim.");
      return options.pushSavedMachineWork(issue, expected);
    },
  };
  if (options.hostDispatch && options.machineClaims)
    throw new Error("Select a single Factory machine claim mode.");
  const machineLease = options.hostDispatch
    ? createUnsignedHostLeasePort({ ...leaseInputs, ...options.hostDispatch })
    : options.machineClaims && createMachineLeasePort({ ...leaseInputs, ...options.machineClaims });

  async function dispatchRecord(issue: number) {
    if (!machineLease || !(await options.hostDispatch?.isPrimary())) return null;
    const snap = await machineLease.readClaim(issue);
    const record = snap?.record;
    if (
      !record ||
      record.released ||
      record.expiresAt * 1000 <= +options.now() ||
      record.installation === here
    )
      return null;
    return record;
  }

  async function readForeignPlan(issue: number): Promise<AdmissionFacts["plan"]> {
    if (options.scopeIssue !== undefined && options.scopeIssue !== issue) return null;
    const record = await dispatchRecord(issue);
    if (!record) return null;
    const data = await readIssue(issue, await readTrustedAccounts(github, repository));
    if (
      !data.trust.trusted ||
      data.summary.state !== "open" ||
      data.labels.includes("factory:blocked")
    )
      return null;
    // The shared login and marker identify a proposal. Only the primary's own decision approves it.
    return latestPlan(data.comments, record.installation, branch(issue), true);
  }

  async function verifyHostSubmission(input: {
    issue: number;
    pullNumber: number;
    head: string;
  }): Promise<HostSubmissionProof | null> {
    const sourceForHead = options.hostSourceForHead;
    const record = await dispatchRecord(input.issue);
    if (!record || !sourceForHead || !options.readApprovedForeignPlan) return null;
    const verify = createObservedSubmission({
      environment: "host",
      repository,
      sourceForHead,
      async readEvidence(issue) {
        const result = await readIssueGateInputs(issue, input.head);
        return result?.trusted && !result.protectedPaths.length ? result.observation : null;
      },
      async readApprovedPlan(issue) {
        const plan = await readForeignPlan(issue);
        if (!plan || !(await options.readApprovedForeignPlan?.(issue, plan))) return null;
        return { planRevision: hostPlanRevision(plan), approvedPaths: plan.files };
      },
    });
    const proof = await verify(input);
    if (proof.kind !== "verified") return null;
    const after = await dispatchRecord(input.issue);
    if (after?.installation !== record.installation || after.generation !== record.generation)
      return null;
    const { issue, pullNumber, head, baseSha, configCommit, planRevision } = proof;
    return {
      repository,
      issue,
      pullNumber,
      head,
      baseSha,
      configCommit,
      planRevision,
      installation: record.installation,
      generation: record.generation,
    };
  }

  // Review threads and configured checks can change without moving the head.
  async function readyToSubmitHost(expected: HostSubmissionProof) {
    if (!(await sameHostProof(expected))) return false;
    const current = await readIssueGateInputs(expected.issue, expected.head);
    return (
      current?.trusted === true &&
      current.configCommit === expected.configCommit &&
      current.observation?.pullNumber === expected.pullNumber &&
      !current.protectedPaths.length &&
      current.trustedThreadsOpen === 0 &&
      current.mergeable === true &&
      (current.hostedChecks === "passing" || current.hostedChecks === "absent")
    );
  }

  async function sameHostProof(expected: HostSubmissionProof) {
    return isDeepStrictEqual(expected, await verifyHostSubmission(expected));
  }
  const leasePort: LeasePort = machineLease ?? {
    async acquire(issue) {
      const data = await readLeaseContext(issue);
      const ready = await prepareClaim(issue, data);
      if ("outcome" in ready) return ready;
      const peer = data.leases.find(
        ({ lease: entry }) => entry.installation !== here && !entry.released,
      );
      if (peer) return { outcome: "foreign", lease: peer.lease };
      const ownMarker = data.leases.find(({ lease: entry }) => entry.installation === here);
      if (ownMarker && !data.own) {
        return {
          outcome: "refused",
          code: "lease-identity",
          reason: "The existing lease belongs to a different GitHub account or protocol version.",
        };
      }
      const claimed = await claimIssue({
        github,
        repository,
        installation: here,
        issue,
        now: options.now(),
        trusted: data.trusted,
        read: () => options.readClaim(issue),
        write: (claim) => options.writeClaim(issue, claim),
      });
      if (claimed.outcome !== "claimed" && claimed.outcome !== "held") {
        return { outcome: "foreign", lease: null };
      }
      const saved = await writeLease(issue, data.own?.comment ?? null, false);
      return {
        outcome: claimed.outcome,
        lease: saved,
        ...ready,
        continueFrom: null,
      };
    },
    async renew(issue) {
      const data = await readLeaseContext(issue);
      const claim = await options.readClaim(issue);
      const head = await readBranch(issue);
      const peer = data.leases.some(
        ({ lease: entry }) => entry.installation !== here && !entry.released,
      );
      if (!data.own || data.own.lease.released || claim?.status !== "held" || !head || peer) {
        throw new FactoryGitHubError("Factory cannot renew an issue lease it no longer holds.");
      }
      return writeLease(issue, data.own.comment, false);
    },
    async release(issue, why) {
      if (why === "takeover")
        throw new FactoryGitHubError(
          "This installation leaves foreign takeovers to the lease coordinator.",
        );
      const data = await readLeaseContext(issue);
      if (data.own && !data.own.lease.released) await writeLease(issue, data.own.comment, true);
    },
    expired(entries, now) {
      return entries.filter(
        (entry) => entry.installation === here && !entry.released && !activeLease(entry, now),
      );
    },
  };

  async function submit(
    target: Parameters<MergeGateDeps["submit"]>[0],
    expectedForeign?: ExpectedSubmission,
    expectedHost?: HostSubmissionProof,
  ): ReturnType<MergeGateDeps["submit"]> {
    const epoch = await options.currentMergeEpoch();
    const lost = {
      kind: "refused" as const,
      reason: "Wait until this installation holds the merge lane.",
    };
    if (epoch === null) return lost;
    const [{ repository: repo }, pull] = await Promise.all([
      graph(repositoryQuery, scope, repositoryData),
      get(`pulls/${target.number}`, pullDetail),
    ]);
    const candidate = pullRef(pull, repo, "passing");
    const matches =
      candidate.sameRepo &&
      candidate.targetsDefaultBranch &&
      candidate.number === target.number &&
      candidate.branch === branch(target.issue) &&
      candidate.headSha === target.headSha &&
      pull.state === "open" &&
      !pull.draft;
    if (!matches)
      return {
        kind: "refused",
        reason: "The approved pull request changed before GitHub could merge it.",
      };
    const input = { pullRequestId: pull.node_id, expectedHeadOid: target.headSha };
    async function submissionRefusal(mergeEpoch: number) {
      if (
        expectedHost &&
        (expectedForeign ||
          expectedHost.issue !== target.issue ||
          expectedHost.pullNumber !== target.number ||
          expectedHost.head !== target.headSha ||
          !(await readyToSubmitHost(expectedHost)))
      ) {
        return {
          kind: "refused" as const,
          reason: "The primary's verified pull request or approved plan changed before merge.",
        };
      }
      const foreignChanged =
        expectedForeign &&
        !(await recheckForeignSubmission(target.issue, target.headSha, expectedForeign));
      if (foreignChanged) {
        return {
          kind: "refused" as const,
          reason: "The signed foreign submission changed before GitHub could merge it.",
        };
      }
      if (machineLease && !expectedForeign && !expectedHost) {
        const head = await readBranch(target.issue);
        const lease = await machineGateLease(target.issue, target.headSha, head);
        if (lease?.installation !== here) {
          return {
            kind: "refused" as const,
            reason: "The local Factory claim moved before merge.",
          };
        }
      }
      return (await options.fenceMerge(mergeEpoch)) ? null : lost;
    }
    if (repo.mergeQueue) {
      const refused = await submissionRefusal(epoch);
      if (refused) return refused;
      await graph(
        `mutation($input:EnqueuePullRequestInput!) { enqueuePullRequest(input:$input) { mergeQueueEntry { id } } }`,
        { input },
        z.object({
          enqueuePullRequest: z.object({ mergeQueueEntry: z.object({ id: z.string() }) }),
        }),
      );
      return { kind: "queued" };
    }
    const allowed = {
      MERGE: repo.mergeCommitAllowed,
      SQUASH: repo.squashMergeAllowed,
      REBASE: repo.rebaseMergeAllowed,
    };
    const mergeMethod = options.mergeMethod ?? "MERGE";
    if (!allowed[mergeMethod])
      return {
        kind: "refused",
        reason: "Choose a merge method enabled for the Factory repository.",
      };
    const refused = await submissionRefusal(epoch);
    if (refused) return refused;
    await graph(
      `mutation($input:MergePullRequestInput!) { mergePullRequest(input:$input) { pullRequest { merged headRefOid } } }`,
      { input: { ...input, mergeMethod } },
      z.object({
        mergePullRequest: z.object({
          pullRequest: z.object({ merged: z.literal(true), headRefOid: z.literal(target.headSha) }),
        }),
      }),
    );
    return { kind: "submitted" };
  }

  async function complete(completion: Completion): ReturnType<MergeGateDeps["complete"]> {
    const lost = {
      done: false as const,
      reason: "Wait until this installation holds the merge lane.",
    };
    const [data, head, claim] = await Promise.all([
      readLeaseContext(completion.issue),
      readBranch(completion.issue),
      machineLease?.readClaim(completion.issue),
    ]);
    if (head !== null && head !== completion.headSha) {
      return {
        done: false,
        reason: "The claim branch moved after merge. Reconcile the remaining lease.",
      };
    }
    if (!completionMatchesClaim(completion, claim ?? null))
      return { done: false, reason: "The issue claim changed after merge." };
    if (!(await options.fenceMerge(completion.epoch))) return lost;
    const result = await options.recordMerge(completion);
    if (!result.done) return result;
    if (data.summary.state === "open") {
      if (
        machineLease &&
        !(await unchangedCompletion(machineLease, completion, claim?.record.generation))
      )
        return { done: false, reason: "The issue claim or work branch moved before closure." };
      if (!(await options.fenceMerge(completion.epoch))) return lost;
      await graph(
        `mutation($id:ID!) { closeIssue(input:{issueId:$id}) { issue { id state } } }`,
        { id: data.summary.node_id },
        z.object({
          closeIssue: z.object({
            issue: z.object({ id: z.literal(data.summary.node_id), state: z.literal("CLOSED") }),
          }),
        }),
      );
    }
    if (machineLease) {
      return completeMachineClaim(machineLease, completion, claim?.record.generation);
    } else if (data.own && !data.own.lease.released) {
      const currentHead = await readBranch(completion.issue);
      if (currentHead !== null && currentHead !== completion.headSha) {
        return {
          done: false,
          reason: "The claim branch moved after merge. Reconcile the remaining lease.",
        };
      }
      if (!(await options.fenceMerge(completion.epoch))) return lost;
      await writeLease(completion.issue, data.own.comment, true);
    }
    return { done: true };
  }

  async function unchangedCompletion(
    claims: MachineLeasePort,
    completion: Completion,
    generation: string | undefined,
  ) {
    const [current, head] = await Promise.all([
      claims.readClaim(completion.issue),
      readBranch(completion.issue),
    ]);
    return (
      (!head || head === completion.headSha) &&
      (!current ||
        (current.record.generation === generation && completionMatchesClaim(completion, current)))
    );
  }

  async function completeMachineClaim(
    claims: MachineLeasePort,
    completion: Completion,
    initialGeneration: string | undefined,
  ): ReturnType<MergeGateDeps["complete"]> {
    const remaining = await claims.readClaim(completion.issue);
    if (!remaining) return { done: true };
    if (
      !completionMatchesClaim(completion, remaining) ||
      remaining.record.generation !== initialGeneration
    )
      return { done: false, reason: "The issue claim changed after merge." };
    if (!(await options.fenceMerge(completion.epoch)))
      return { done: false, reason: "Wait until this installation holds the merge lane." };
    if (!(await unchangedCompletion(claims, completion, initialGeneration)))
      return { done: false, reason: "The issue claim or work branch moved before cleanup." };
    if (!(await claims.deleteCompletedClaim(completion.issue, remaining.revision)))
      return { done: false, reason: "Reconcile the issue claim after merge." };
    return { done: true };
  }

  function completionMatchesClaim(completion: Completion, claim: ClaimSnapshot | null): boolean {
    const verified = completion.hostProof;
    if (verified)
      return (
        !!options.hostDispatch &&
        verified.repository === repository &&
        verified.issue === completion.issue &&
        verified.head === completion.headSha &&
        (!claim ||
          (claim.record.installation === verified.installation &&
            claim.record.generation === verified.generation))
      );
    const expected = completion.foreignSubmission;
    if (expected && (!machineLease || expected.head !== completion.headSha)) return false;
    if (!claim) return true;
    return expected ? matchesSubmission(claim, expected) : claim.record.installation === here;
  }

  async function readClaimFacts(
    issue: number,
    data: Awaited<ReturnType<typeof readIssue>>,
    viewer: string,
  ) {
    const now = options.now();
    let leases: Lease[];
    let locallyHeld: boolean;
    if (machineLease) {
      const observed = await machineLease.readLease(issue);
      const current =
        observed && !observed.released && !machineLease.expired([observed], now).length;
      leases = current ? [observed] : [];
      locallyHeld = Boolean(
        observed?.installation === here &&
        !observed.released &&
        Date.parse(observed.expiresAt) > +now,
      );
    } else {
      const local = ownLease(data.leases, viewer);
      leases = data.leases.map((entry) => entry.lease);
      locallyHeld = Boolean(local && activeLease(local.lease, now));
    }
    if (!locallyHeld) return { leases, plan: null };
    const builderComments = data.comments.filter(
      (entry) => entry.user?.login.toLowerCase() === viewer.toLowerCase(),
    );
    return { leases, plan: latestPlan(builderComments, here, branch(issue)) };
  }

  async function readFacts(trackedIssues: readonly number[] = []): Promise<LeanGitHubFacts> {
    const [{ repository: repo, viewer }, trusted, ready] = await Promise.all([
      graph(repositoryQuery, scope, repositoryData),
      readTrustedAccounts(github, repository),
      options.scopeIssue === undefined
        ? pages("issues?state=open&labels=factory%3Aready", issueSummary)
        : Promise.resolve([]),
    ]);
    const issueNumbers = new Set(
      options.scopeIssue === undefined
        ? [
            ...ready
              .filter((entry) => entry.pull_request === undefined)
              .map((entry) => entry.number),
            ...trackedIssues,
          ]
        : [options.scopeIssue],
    );
    const snapshot: LeanGitHubFacts = {
      issues: [],
      pulls: [],
      leases: [],
      verdicts: [],
      acceptances: [],
      merged: [],
      defaultBranchSha: repo.defaultBranchRef.target.oid,
      readAt: options.now().toISOString(),
    };
    for (const issue of issueNumbers) {
      const [data, pulls] = await Promise.all([readIssue(issue, trusted), candidates(issue, repo)]);
      const { leases, plan } = await readClaimFacts(issue, data, viewer.login);
      snapshot.leases.push(...leases);
      const go = plan ? await options.readGo(issue, plan) : null;
      if (data.summary.state === "open") {
        snapshot.issues.push({
          number: issue,
          title: data.facts.title,
          labels: data.labels,
          trust: data.trust,
          heavy: data.labels.includes("factory:heavy"),
          priority: data.labels.includes("factory:priority"),
          createdAt: data.facts.createdAt,
          plan,
          go,
          questions: [],
          sendBacks: [],
        });
      }
      const open = findOpen(pulls);
      if (open) {
        const inspected = await inspectOpen(open, repo, trusted);
        const { pull } = inspected;
        const pending = inspected.kind === "queued";
        const fact: PullFacts = {
          number: pull.number,
          head: pull.headSha,
          branch: pull.branch,
          sameRepo: pull.sameRepo && pull.targetsDefaultBranch,
          files: pending ? [] : inspected.files,
          checks: pull.checks,
          mergeable: pending ? null : inspected.mergeable,
          trustedThreadsOpen: pending ? 0 : inspected.trustedThreadsOpen,
          labels: pending ? open.labels.map((entry) => entry.name) : inspected.labels,
        };
        snapshot.pulls.push(fact);
        continue;
      }
      const merged = await findMerged(issue, pulls);
      if (!merged) continue;
      const evidence = await mergedPull(merged, repo);
      if (evidence.kind === "merged")
        snapshot.merged.push({ issue, pr: evidence.pull, mergeSha: evidence.mergeSha });
    }
    return snapshot;
  }

  return {
    readFacts,
    readForeignPlan,
    verifyHostSubmission,
    machineLease,
    readIssueGateInputs,
    lease: leasePort,
    gateDeps: {
      here,
      read: readGate,
      currentMergeEpoch: options.currentMergeEpoch,
      fenceMerge: options.fenceMerge,
      readIntent: options.readIntent,
      recordIntent: options.recordIntent,
      submit,
      complete,
    },
  };
}
