import { isAbsolute } from "node:path";
import { OWNER_ONLY_FILES } from "../../project/claims.js";
import { createEvidenceGit, type LeanEvidenceSource } from "../gate-bootstrap.js";
export interface ObservedApprovalPlan {
  planRevision: string;
  approvedPaths: readonly string[];
}

/** Validated GitHub facts for the unique PR on the issue branch, independently of any submission. */
export interface ObservedPullEvidence {
  issue: number;
  pullNumber: number;
  state: "open" | "closed";
  draft: boolean;
  headRepository: string;
  baseRepository: string;
  headBranch: string;
  baseBranch: string;
  defaultBranch: string;
  headSha: string;
  branchHeadSha: string;
  baseSha: string;
  defaultHeadSha: string;
  trusted: boolean;
  blocked: boolean;
  filesComplete: boolean;
  files: readonly { path: string; previousPath?: string }[];
  /** Complete owner recipe protection from the pinned default commit. */
  protectedPaths: readonly string[];
}

export interface ObservedSubmissionOptions {
  environment: "host" | "container";
  repository: string;
  /** Read only the primary's durable approval for this issue and plan revision. */
  readApprovedPlan(issue: number): Promise<ObservedApprovalPlan | null>;
  /** Read current trusted issue, PR, branch and owner policy facts from GitHub. */
  readEvidence(issue: number): Promise<ObservedPullEvidence | null>;
  /** Daemon-owned private Git pool pinned using createLeanGateBootstrap.sourceForHead. */
  sourceForHead(target: {
    issue: number;
    headSha: string;
    baseSha: string;
  }): Promise<LeanEvidenceSource | null>;
  gitBinary?: string;
}

type Refusal =
  | "unapproved-plan"
  | "untrusted-pull"
  | "unverified-source"
  | "unverified-diff"
  | "unapproved-path"
  | "evidence-changed";

export interface HostSubmissionProof {
  issue: number;
  repository: string;
  pullNumber: number;
  head: string;
  baseSha: string;
  configCommit: string;
  planRevision: string;
}

export type ObservedSubmissionResult =
  | { kind: "refused"; reason: Refusal }
  | ({ kind: "verified" } & HostSubmissionProof);

interface RequestedPull {
  issue: number;
  pullNumber: number;
  head: string;
}

const oid = /^[a-f0-9]{40}$/u;
const maxDiffBytes = 256 * 1024;
const maxPaths = 256;
const ownerPaths = [...OWNER_ONLY_FILES, ".github/vorteo-factory.json", ".github/workflows"];
const diffEntry = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([ADM])$/u;
const zero = "0".repeat(40);

function workBranch(issue: number): string {
  return `factory/issue-${issue}`;
}

function safePath(path: string): boolean {
  return (
    Buffer.byteLength(path) <= 1024 &&
    !/[\\\p{Cc}\uFFFD]/u.test(path) &&
    path
      .split("/")
      .every(
        (part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git",
      )
  );
}

function normalizePaths(paths: readonly string[]): string[] | null {
  if (paths.length > maxPaths || !paths.every(safePath)) return null;
  return [...new Set(paths)].sort();
}

function unchanged(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function regular(mode: string, sha: string): boolean {
  return (mode === "100644" || mode === "100755") && sha !== zero;
}

function validChange(metadata: string): boolean {
  const entry = diffEntry.exec(metadata);
  if (!entry) return false;
  const [, before, after, oldOid, newOid, status] = entry;
  const oldRegular = regular(before, oldOid);
  const newRegular = regular(after, newOid);
  if (status === "M") return oldRegular && newRegular;
  if (status === "A") return before === "000000" && oldOid === zero && newRegular;
  return oldRegular && after === "000000" && newOid === zero;
}

function completeRegularDiff(output: string): string[] | null {
  if (!output.endsWith("\0")) return null;
  const entries = output.slice(0, -1).split("\0");
  if (entries.length % 2 !== 0 || entries.length > maxPaths * 2) return null;
  const paths = new Set<string>();
  for (let i = 0; i < entries.length; i += 2) {
    if (!validChange(entries[i]) || !safePath(entries[i + 1]) || paths.has(entries[i + 1]))
      return null;
    paths.add(entries[i + 1]);
  }
  return [...paths].sort();
}

export function createObservedSubmission(options: ObservedSubmissionOptions) {
  if (options.environment !== "host" || process.env.PASEO_NETWORK_MODE) {
    throw new Error("Submission observation requires the native Factory Host.");
  }
  const git = createEvidenceGit(options.gitBinary);
  const repository = options.repository.toLowerCase();

  async function approvedPlan(issue: number) {
    const plan = await options.readApprovedPlan(issue);
    if (!plan?.planRevision.trim()) return null;
    const paths = normalizePaths(plan.approvedPaths);
    if (!paths?.length) return null;
    return {
      paths: new Set(paths),
      planRevision: plan.planRevision,
      binding: JSON.stringify([plan.planRevision, paths]),
    };
  }

  function matchesPullRefs(evidence: ObservedPullEvidence, issue: number): boolean {
    if (
      evidence.headRepository.toLowerCase() !== repository ||
      evidence.baseRepository.toLowerCase() !== repository
    )
      return false;
    if (
      evidence.headBranch !== workBranch(issue) ||
      !evidence.defaultBranch ||
      evidence.baseBranch !== evidence.defaultBranch
    )
      return false;
    const { headSha, baseSha } = evidence;
    if (
      !oid.test(headSha) ||
      !oid.test(baseSha) ||
      evidence.branchHeadSha !== headSha ||
      evidence.defaultHeadSha !== baseSha
    )
      return false;
    return true;
  }

  async function pull({ issue, pullNumber, head }: RequestedPull) {
    const evidence = await options.readEvidence(issue);
    if (!evidence || evidence.issue !== issue || evidence.state !== "open" || evidence.draft)
      return null;
    if (!evidence.trusted || evidence.blocked || !evidence.filesComplete) return null;
    if (evidence.pullNumber !== pullNumber || evidence.headSha !== head) return null;
    if (!matchesPullRefs(evidence, issue)) return null;
    const { headSha, baseSha } = evidence;
    const paths = normalizePaths(
      evidence.files.flatMap(({ path, previousPath }) =>
        previousPath === undefined ? [path] : [path, previousPath],
      ),
    );
    const protectedPaths = normalizePaths(evidence.protectedPaths);
    if (!paths?.length || !protectedPaths) return null;
    const binding = JSON.stringify([
      evidence.pullNumber,
      evidence.defaultBranch,
      headSha,
      baseSha,
      paths,
      protectedPaths,
    ]);
    return { pullNumber: evidence.pullNumber, headSha, baseSha, paths, protectedPaths, binding };
  }

  async function readDiff(source: LeanEvidenceSource): Promise<string[] | null> {
    const { baseSha, head, gitDirectory } = source;
    try {
      const bases = await git(gitDirectory, ["merge-base", "--all", baseSha, head]);
      const mergeBase = bases.trim();
      if (!oid.test(mergeBase)) return null;
      // Disabling rename detection emits deletion and addition for both paths in a rename.
      const output = await git(
        gitDirectory,
        [
          "diff-tree",
          "--no-commit-id",
          "--raw",
          "--no-abbrev",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          "--no-relative",
          "-r",
          "-z",
          mergeBase,
          head,
        ],
        { maxBuffer: maxDiffBytes },
      );
      return completeRegularDiff(output);
    } catch {
      // Missing objects, unrelated history and oversized output all lack complete proof.
      return null;
    }
  }

  async function checkChanges(
    issue: number,
    approvedPaths: ReadonlySet<string>,
    current: NonNullable<Awaited<ReturnType<typeof pull>>>,
  ): Promise<{ source: LeanEvidenceSource } | { reason: Refusal }> {
    const { headSha, baseSha, paths } = current;
    const source = await options.sourceForHead({ issue, headSha, baseSha });
    if (
      !source ||
      source.repository.toLowerCase() !== repository ||
      source.head !== headSha ||
      source.baseSha !== baseSha ||
      !isAbsolute(source.gitDirectory)
    )
      return { reason: "unverified-source" };
    const actual = await readDiff(source);
    if (!actual || !unchanged(actual, paths)) return { reason: "unverified-diff" };
    const protectedNames = new Set(
      [...ownerPaths, ...current.protectedPaths].map((path) => path.toLowerCase()),
    );
    if (
      actual.some(
        (path) =>
          !approvedPaths.has(path) ||
          protectedNames.has(path.toLowerCase()) ||
          path.toLowerCase().startsWith(".github/workflows/"),
      )
    )
      return { reason: "unapproved-path" };

    return { source };
  }

  return async function observe(input: RequestedPull): Promise<ObservedSubmissionResult> {
    const { issue, pullNumber, head } = input;
    if (
      ![issue, pullNumber].every((number) => Number.isSafeInteger(number) && number > 0) ||
      !oid.test(head)
    ) {
      return { kind: "refused", reason: "untrusted-pull" };
    }
    const request = { issue, pullNumber, head };
    const [plan, current] = await Promise.all([approvedPlan(issue), pull(request)]);
    if (!plan) return { kind: "refused", reason: "unapproved-plan" };
    if (!current) return { kind: "refused", reason: "untrusted-pull" };
    const verified = await checkChanges(issue, plan.paths, current);
    if ("reason" in verified) return { kind: "refused", reason: verified.reason };

    const [finalPlan, finalPull] = await Promise.all([approvedPlan(issue), pull(request)]);
    if (finalPlan?.binding !== plan.binding || finalPull?.binding !== current.binding) {
      return { kind: "refused", reason: "evidence-changed" };
    }
    const { source } = verified;
    return {
      kind: "verified",
      issue,
      repository: source.repository,
      pullNumber,
      head,
      baseSha: source.baseSha,
      configCommit: source.baseSha,
      planRevision: plan.planRevision,
    };
  };
}
