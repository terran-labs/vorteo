import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

export type GatedRole = "factory-intake" | "factory-triage" | "factory-builds";
export interface GhRunner {
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
}
const execute = promisify(execFile);
export const defaultGhRunner: GhRunner = {
  async graphql(query, variables) {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value !== null) args.push("-F", `${key}=${String(value)}`);
    }
    const { stdout } = await execute("gh", args, {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  },
};

const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});
const labels = z.object({
  nodes: z.array(z.object({ name: z.string() })),
  pageInfo,
});
const issue = z.object({ number: z.number(), updatedAt: z.string(), labels });
const pullRequest = z.object({
  number: z.number(),
  headRefName: z.string(),
  headRefOid: z.string(),
  reviewDecision: z.string().nullable(),
  mergeStateStatus: z.string(),
  latestReviews: z.object({
    nodes: z.array(z.object({ id: z.string(), state: z.string() })),
    pageInfo: z.object({ hasPreviousPage: z.boolean() }),
  }),
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
});
const head = z.object({
  defaultBranchRef: z.object({ target: z.object({ oid: z.string() }) }),
});
const issueFields = `nodes { number updatedAt labels(first:100) { nodes { name } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor }`;
const prFields = `nodes { number headRefName headRefOid reviewDecision mergeStateStatus
  latestReviews(last:100) { nodes { id state } pageInfo { hasPreviousPage } }
  commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
} pageInfo { hasNextPage endCursor }`;

interface FingerprintContext {
  repository: string;
  gh: GhRunner;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Missing or incomplete GitHub evidence must wake the agent, never suppress a tick. */
export async function computeFingerprint(
  role: GatedRole,
  ctx: FingerprintContext,
): Promise<string | null> {
  try {
    const parts = ctx.repository.split("/");
    if (parts.length !== 2 || parts.some((part) => !/^[\w.-]+$/.test(part))) return null;
    const [owner, name] = parts;
    const issues: z.infer<typeof issue>[] = [];
    const prs: z.infer<typeof pullRequest>[] = [];
    let issueCursor: string | null = null;
    let prCursor: string | null = null;
    let needIssues = role !== "factory-builds";
    let needPrs = role === "factory-intake";
    let oid: string | null = null;
    do {
      const fields = [];
      if (role !== "factory-triage") fields.push("defaultBranchRef { target { oid } }");
      if (needIssues)
        fields.push(
          `issues(first:100, after:$issueCursor, states:OPEN, orderBy:{field:UPDATED_AT,direction:DESC}) { ${issueFields} }`,
        );
      if (needPrs)
        fields.push(`pullRequests(first:100, after:$prCursor, states:OPEN) { ${prFields} }`);
      const declarations = ["$owner:String!", "$name:String!"];
      const variables: Record<string, unknown> = { owner, name };
      if (needIssues) {
        declarations.push("$issueCursor:String");
        variables.issueCursor = issueCursor;
      }
      if (needPrs) {
        declarations.push("$prCursor:String");
        variables.prCursor = prCursor;
      }
      const query = `query(${declarations.join(
        ",",
      )}) { repository(owner:$owner,name:$name) { ${fields.join(" ")} } }`;
      const response = await ctx.gh.graphql(query, variables);
      const envelope = z
        .object({
          data: z.object({ repository: z.record(z.string(), z.unknown()) }),
          errors: z.unknown().optional(),
        })
        .parse(response);
      if (envelope.errors !== undefined) return null;
      const repository = envelope.data.repository;
      if (role !== "factory-triage") oid = head.parse(repository).defaultBranchRef.target.oid;
      if (needIssues) {
        const page = z.object({ nodes: z.array(issue), pageInfo }).parse(repository.issues);
        issues.push(...page.nodes);
        needIssues = role === "factory-intake" && page.pageInfo.hasNextPage;
        if (needIssues && invalidCursor(page.pageInfo.endCursor, issueCursor)) return null;
        issueCursor = page.pageInfo.endCursor;
      }
      if (needPrs) {
        const page = z
          .object({ nodes: z.array(pullRequest), pageInfo })
          .parse(repository.pullRequests);
        prs.push(...page.nodes);
        needPrs = page.pageInfo.hasNextPage;
        if (needPrs && invalidCursor(page.pageInfo.endCursor, prCursor)) return null;
        prCursor = page.pageInfo.endCursor;
      }
    } while (needIssues || needPrs);
    return hashInputs(role, oid, issues, prs);
  } catch {
    // The gate deliberately fails open on CLI, API and validation errors.
    return null;
  }
}

interface WakeInput {
  role: string;
  current: string | null;
  last: string | null;
  lastWakeAt: string | null;
  now: Date;
  pending: boolean;
  maxQuietMs?: number;
}
interface WakeDecision {
  wake: boolean;
  reason:
    | "ungated-role"
    | "fingerprint-unavailable"
    | "changed"
    | "pending"
    | "first"
    | "max-quiet"
    | "unchanged";
}
export function shouldWake(input: WakeInput): WakeDecision {
  if (!["factory-intake", "factory-triage", "factory-builds"].includes(input.role))
    return { wake: true, reason: "ungated-role" };
  if (input.current === null) return { wake: true, reason: "fingerprint-unavailable" };
  if (input.last === null || input.lastWakeAt === null) return { wake: true, reason: "first" };
  if (input.current !== input.last) return { wake: true, reason: "changed" };
  if (input.pending) return { wake: true, reason: "pending" };
  const elapsed = input.now.getTime() - Date.parse(input.lastWakeAt);
  const withinQuietWindow =
    Number.isFinite(elapsed) && elapsed >= 0 && elapsed < (input.maxQuietMs ?? 6 * 60 * 60 * 1000);
  if (!withinQuietWindow) return { wake: true, reason: "max-quiet" };
  return { wake: false, reason: "unchanged" };
}

function hashInputs(
  role: GatedRole,
  oid: string | null,
  issues: z.infer<typeof issue>[],
  prs: z.infer<typeof pullRequest>[],
): string | null {
  if (issues.some((item) => item.labels.pageInfo.hasNextPage)) return null;
  const trackedIssues = issues.filter(
    (item) =>
      role === "factory-triage" ||
      item.labels.nodes.some((label) =>
        ["factory:ready", "factory:running", "factory:blocked"].includes(label.name),
      ),
  );
  const issueInputs = trackedIssues
    .map((item) => ({
      number: item.number,
      updatedAt: item.updatedAt,
      labels: item.labels.nodes.map((label) => label.name).sort(),
    }))
    .sort((a, b) => a.number - b.number);
  // Claim branches are factory/issue-<n>; <prefix>/factory-issue-<n> predates claims.
  const trackedPrs = prs.filter(
    (item) =>
      item.headRefName.startsWith("factory/issue-") || item.headRefName.includes("factory-issue-"),
  );
  if (trackedPrs.some((item) => item.latestReviews.pageInfo.hasPreviousPage)) return null;
  const prInputs = trackedPrs
    .map((item) => ({
      number: item.number,
      headRefOid: item.headRefOid,
      reviewDecision: item.reviewDecision,
      reviews: item.latestReviews.nodes.toSorted((a, b) => a.id.localeCompare(b.id)),
      statusCheckRollup: item.commits.nodes[0]!.commit.statusCheckRollup,
      mergeStateStatus: item.mergeStateStatus,
    }))
    .sort((a, b) => a.number - b.number);
  let inputs: unknown = { oid };
  if (role === "factory-triage") inputs = { issues: issueInputs };
  if (role === "factory-intake") inputs = { oid, issues: issueInputs, prs: prInputs };
  return createHash("sha256").update(canonical(inputs)).digest("hex");
}

function invalidCursor(next: string | null, previous: string | null): boolean {
  return !next || next === previous;
}
