import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { Acceptance, PullRef, RunnerRef, Verdict } from "./types.js";

const exec = promisify(execFile);
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
type GitObjectType = "commit" | "tree" | "blob";

export interface ReviewGitObjects {
  read(type: GitObjectType, oid: string): Promise<Buffer>;
  mergeBases(first: string, second: string): Promise<string[]>;
  isLinearDescendant(base: string, head: string): Promise<boolean>;
}

/** The directory must be the daemon's verified object database for this project. */
export function createGitReviewObjects(gitDirectory: string): ReviewGitObjects {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  async function git(args: string[]): Promise<Buffer> {
    const { stdout } = await exec(
      "git",
      ["--no-replace-objects", "--git-dir", gitDirectory, ...args],
      {
        env: { ...env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
        encoding: "buffer",
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    return stdout;
  }
  return {
    read(type, oid) {
      if (!oidPattern.test(oid)) throw new Error("Invalid Git object ID.");
      return git(["cat-file", type, oid]);
    },
    async mergeBases(first, second) {
      if (!oidPattern.test(first) || !oidPattern.test(second))
        throw new Error("Invalid Git object ID.");
      return (await git(["merge-base", "--all", first, second]))
        .toString("ascii")
        .trim()
        .split(/\s+/);
    },
    async isLinearDescendant(base, head) {
      if (!oidPattern.test(base) || !oidPattern.test(head) || base === head) return false;
      await git(["merge-base", "--is-ancestor", base, head]);
      const merges = await git(["rev-list", "--max-count=1", "--merges", `${base}..${head}`]);
      return merges.length === 0;
    },
  };
}

/** Daemon account-selection receipt. Compatible with the runner ledger's ReviewAccountSelection. */
export interface ReviewLaunchEvidence {
  issue: number;
  headSha: string;
  at: string;
  daemonCreated: true;
  clean: true;
  nonChild: true;
  freshSession: true;
  builderAgentId: string;
  builderAccount: string;
  builderAccountDefinition: string;
  reviewerAgentId: string;
  reviewerAccount: string;
  reviewerAccountDefinition: string;
  mode: "different-account" | "same-account";
  candidates: readonly { accountDefinition: string | null; reason: string }[];
}

interface ReviewTarget {
  issue: number;
  pullNumber: number;
  baseSha: string;
  headSha: string;
}

export interface PriorReviewEvidence extends ReviewTarget {
  builder: RunnerRef;
  reviewer: RunnerRef;
  verdict: Verdict;
  acceptance: Acceptance;
  acceptanceSession: RunnerRef;
  reviewAccountSelection?: ReviewLaunchEvidence;
}

export interface CurrentRebaseEvidence extends ReviewTarget {
  checksHeadSha: string | null;
  checks: PullRef["checks"];
}

export interface CleanRebaseProof {
  kind: "clean-rebase";
  prior: PriorReviewEvidence;
  current: CurrentRebaseEvidence & { checks: "passing"; checksHeadSha: string };
  resultingTree: string;
  changedPaths: string[];
}

const ineligibleAlternates = new Set([
  "profile-bound",
  "not-allowed",
  "wrong-provider",
  "unavailable-on-destination",
  "parked",
  "exhausted",
]);

function sameRunner(first: RunnerRef, second: RunnerRef): boolean {
  return (
    first.agentId === second.agentId &&
    first.role === second.role &&
    first.serverId === second.serverId &&
    first.account === second.account &&
    first.accountDefinition === second.accountDefinition &&
    first.providerType === second.providerType &&
    first.openedAt === second.openedAt &&
    first.attempt === second.attempt
  );
}

function hasKnownReviewAccounts(builder: RunnerRef, reviewer: RunnerRef): boolean {
  return (
    builder.role === "lead" &&
    reviewer.role === "reviewer" &&
    builder.serverId === null &&
    reviewer.serverId === null &&
    builder.agentId !== reviewer.agentId &&
    Boolean(builder.accountDefinition) &&
    Boolean(reviewer.accountDefinition)
  );
}

function matchesLaunch(
  issue: number,
  headSha: string,
  builder: RunnerRef,
  reviewer: RunnerRef,
  selection: ReviewLaunchEvidence,
): boolean {
  return (
    selection.issue === issue &&
    selection.headSha === headSha &&
    selection.daemonCreated === true &&
    selection.clean === true &&
    selection.nonChild === true &&
    selection.freshSession === true &&
    Number.isFinite(Date.parse(selection.at)) &&
    selection.builderAgentId === builder.agentId &&
    selection.builderAccount === builder.account &&
    selection.builderAccountDefinition === builder.accountDefinition &&
    selection.reviewerAgentId === reviewer.agentId &&
    selection.reviewerAccount === reviewer.account &&
    selection.reviewerAccountDefinition === reviewer.accountDefinition
  );
}

function provesSameAccountFallback(selection: ReviewLaunchEvidence): boolean {
  if (selection.mode !== "same-account") return false;
  const selected = selection.candidates.filter(({ reason }) => reason === "selected");
  return (
    selected.length === 1 &&
    selected[0].accountDefinition === selection.reviewerAccountDefinition &&
    selection.candidates.every(
      (candidate) =>
        candidate === selected[0] ||
        ineligibleAlternates.has(candidate.reason) ||
        (candidate.reason === "builder-account" &&
          candidate.accountDefinition === selection.builderAccountDefinition),
    )
  );
}

function priorIsApproved(prior: PriorReviewEvidence): boolean {
  const { issue, headSha, builder, reviewer, verdict, acceptance, acceptanceSession } = prior;
  if (!hasKnownReviewAccounts(builder, reviewer) || !sameRunner(verdict.reviewer, reviewer))
    return false;
  if (builder.accountDefinition === reviewer.accountDefinition) {
    const launch = prior.reviewAccountSelection;
    if (
      !launch ||
      !matchesLaunch(issue, headSha, builder, reviewer, launch) ||
      !provesSameAccountFallback(launch)
    )
      return false;
  }
  const localVerdict =
    verdict.sha === headSha && verdict.approved && verdict.source === "local-runner";
  const localAcceptance =
    acceptance.sha === headSha &&
    acceptance.outcome === "accepted" &&
    acceptance.source === "local-session" &&
    acceptance.session === acceptanceSession.agentId &&
    Number.isFinite(Date.parse(acceptance.at));
  const distinctSession =
    acceptanceSession.role === "foreman-op" &&
    acceptanceSession.serverId === null &&
    acceptanceSession.agentId !== builder.agentId &&
    acceptanceSession.agentId !== reviewer.agentId;
  return localVerdict && localAcceptance && distinctSession;
}

interface TreeEntry {
  mode: string;
  oid: string;
}

const treeMode = "40000";
const validModes = new Set([treeMode, "100644", "100755", "120000", "160000"]);

function oidFor(type: GitObjectType, data: Buffer, oidLength: number): string {
  return createHash(oidLength === 40 ? "sha1" : "sha256")
    .update(`${type} ${data.length}\0`)
    .update(data)
    .digest("hex");
}

function encodeTree(entries: ReadonlyMap<string, TreeEntry>): Buffer {
  const typedNames = [...entries].map(([name, { mode, oid }]) => ({
    name: Buffer.from(name),
    sort: Buffer.from(mode === treeMode ? `${name}/` : name),
    mode,
    oid,
  }));
  typedNames.sort((left, right) => Buffer.compare(left.sort, right.sort));
  return Buffer.concat(
    typedNames.flatMap(({ name, mode, oid }) => [
      Buffer.from(`${mode} `),
      name,
      Buffer.from([0]),
      Buffer.from(oid, "hex"),
    ]),
  );
}

function parseTree(raw: Buffer, oidLength: number): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  const oidBytes = oidLength / 2;
  let offset = 0;
  while (offset < raw.length) {
    const nul = raw.indexOf(0, offset);
    const separator = raw.indexOf(32, offset);
    if (separator < offset || nul <= separator || nul + 1 + oidBytes > raw.length) {
      throw new Error("Git tree entries are malformed.");
    }
    const mode = raw.toString("ascii", offset, separator);
    const bytes = raw.subarray(separator + 1, nul);
    const name = bytes.toString("utf8");
    if (
      !validModes.has(mode) ||
      !bytes.equals(Buffer.from(name)) ||
      !isGitPath(name) ||
      name.includes("/") ||
      entries.has(name)
    )
      throw new Error("Git tree paths or modes are ambiguous.");
    const oid = raw.toString("hex", nul + 1, nul + 1 + oidBytes);
    entries.set(name, { mode, oid });
    offset = nul + 1 + oidBytes;
  }
  if (!encodeTree(entries).equals(raw)) throw new Error("Git tree encoding is ambiguous.");
  return entries;
}

function isGitPath(path: string): boolean {
  return (
    !/[\p{Cc}\\]/u.test(path) &&
    path
      .split("/")
      .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  );
}

function equalEntry(first: TreeEntry | undefined, second: TreeEntry | undefined): boolean {
  return first?.mode === second?.mode && first?.oid === second?.oid;
}

function verifiedTreeReapplication(objects: ReviewGitObjects, oidLength: number) {
  const cache = new Map<string, Promise<Buffer>>();
  const changedPaths = new Set<string>();

  function verified(type: GitObjectType, oid: string): Promise<Buffer> {
    if (!oidPattern.test(oid) || oid.length !== oidLength)
      throw new Error("Invalid Git object ID.");
    const key = `${type}:${oid}`;
    let data = cache.get(key);
    if (!data) {
      data = objects.read(type, oid).then((raw) => {
        if (oidFor(type, raw, oidLength) !== oid)
          throw new Error("A Git object did not match its ID.");
        return raw;
      });
      cache.set(key, data);
    }
    return data;
  }

  async function commitTree(oid: string): Promise<string> {
    const commit = await verified("commit", oid);
    const boundary = commit.indexOf("\n\n");
    if (boundary < 0) throw new Error("Git commit headers are incomplete.");
    const header = commit.toString("utf8", 0, boundary).split("\n");
    const trees = header.filter((line) => line.startsWith("tree "));
    if (trees.length !== 1 || trees[0] !== header[0])
      throw new Error("Git commit tree is ambiguous.");
    return trees[0].slice(5);
  }

  async function readTree(oid: string): Promise<Map<string, TreeEntry>> {
    return parseTree(await verified("tree", oid), oidLength);
  }

  async function recordPath(path: string, entry?: TreeEntry): Promise<void> {
    if (!entry) return;
    if (entry.mode === treeMode) {
      const contents = await readTree(entry.oid);
      if (!contents.size) changedPaths.add(path);
      for (const [name, child] of contents) await recordPath(`${path}/${name}`, child);
      return;
    }
    if (entry.mode !== "160000") await verified("blob", entry.oid);
    changedPaths.add(path);
  }

  async function reapply(
    oldBaseTree: string,
    oldHeadTree: string,
    newBaseTree: string,
    prefix = "",
  ): Promise<string> {
    if (oldBaseTree === oldHeadTree) return newBaseTree;
    const [before, after, upstream] = await Promise.all([
      readTree(oldBaseTree),
      readTree(oldHeadTree),
      readTree(newBaseTree),
    ]);
    const combined = new Map(upstream);
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const oldEntry = before.get(name);
      const reviewedEntry = after.get(name);
      if (equalEntry(oldEntry, reviewedEntry)) continue;
      const baseEntry = upstream.get(name);
      const path = `${prefix}${name}`;
      if (
        oldEntry?.mode === treeMode &&
        reviewedEntry?.mode === treeMode &&
        baseEntry?.mode === treeMode
      ) {
        combined.set(name, {
          mode: treeMode,
          oid: await reapply(oldEntry.oid, reviewedEntry.oid, baseEntry.oid, `${path}/`),
        });
        continue;
      }
      if (!equalEntry(oldEntry, baseEntry))
        throw new Error("The updated base changed a reviewed path.");
      await recordPath(path, oldEntry);
      await recordPath(path, reviewedEntry);
      if (reviewedEntry) combined.set(name, reviewedEntry);
      else combined.delete(name);
    }
    return oidFor("tree", encodeTree(combined), oidLength);
  }

  return { commitTree, readTree, reapply, changedPaths };
}

export async function proveCleanRebase(
  objects: ReviewGitObjects,
  prior: PriorReviewEvidence,
  current: CurrentRebaseEvidence,
): Promise<{ proved: true; proof: CleanRebaseProof } | { proved: false; reason: string }> {
  const oidLength = prior.headSha.length;
  const targets = [prior.baseSha, prior.headSha, current.baseSha, current.headSha];
  if (
    prior.issue !== current.issue ||
    prior.pullNumber !== current.pullNumber ||
    !targets.every((oid) => oidPattern.test(oid) && oid.length === oidLength) ||
    prior.headSha === current.headSha ||
    !priorIsApproved(prior)
  ) {
    return {
      proved: false,
      reason: "Factory could not verify the prior approvals for this pull request.",
    };
  }
  const { checks, checksHeadSha } = current;
  if (checks !== "passing" || checksHeadSha !== current.headSha) {
    return { proved: false, reason: "Wait for fresh passing checks on the rebased head." };
  }

  try {
    const git = verifiedTreeReapplication(objects, oidLength);
    const [oldBase, oldHead, newBase, newHead] = await Promise.all(targets.map(git.commitTree));
    const [bases, oldLinear, newLinear] = await Promise.all([
      objects.mergeBases(prior.headSha, current.baseSha),
      objects.isLinearDescendant(prior.baseSha, prior.headSha),
      objects.isLinearDescendant(current.baseSha, current.headSha),
      git.readTree(newHead),
    ]);
    if (
      bases.length !== 1 ||
      bases[0] !== prior.baseSha ||
      !oldLinear ||
      !newLinear ||
      current.baseSha === prior.headSha
    ) {
      return { proved: false, reason: "The rebased commit has an ambiguous base or history." };
    }
    const resultingTree = await git.reapply(oldBase, oldHead, newBase);
    if (resultingTree !== newHead || git.changedPaths.size === 0) {
      return {
        proved: false,
        reason: "The rebased tree differs from the reviewed changes reapplied to the new base.",
      };
    }
    return {
      proved: true,
      proof: {
        kind: "clean-rebase",
        prior: structuredClone(prior),
        current: { ...current, checks, checksHeadSha },
        resultingTree,
        changedPaths: [...git.changedPaths].sort(),
      },
    };
  } catch {
    return {
      proved: false,
      reason: "Factory could not reapply the reviewed changes cleanly from verified Git objects.",
    };
  }
}

export interface SecurityReviewBinding {
  issue: number;
  headSha: string;
  purpose: "security-review";
  runner: RunnerRef;
  selection: ReviewLaunchEvidence;
}

interface SecurityReviewContext {
  issue: number;
  headSha: string;
  /** Actual paths touched by the current head that match the project's policy. */
  sensitivePaths: readonly string[];
  builder: RunnerRef;
  primaryReviewer: RunnerRef;
  binding: SecurityReviewBinding;
}

export interface SecurityReviewEvidence {
  kind: "security-review";
  issue: number;
  sha: string;
  reviewer: RunnerRef;
  source: "local-runner";
  approved: boolean;
  sensitivePaths: string[];
  findings: string;
  reviewedAt: string;
}

const securityReply = z.strictObject({
  kind: z.literal("security-review"),
  sha: z.string().regex(oidPattern),
  approved: z.boolean(),
  sensitivePaths: z.array(z.string()).min(1),
  findings: z.string().refine((value) => value.trim().length > 0),
});

function securityBindingValid(context: SecurityReviewContext): boolean {
  const { issue, headSha, builder, primaryReviewer, binding } = context;
  const { runner, selection } = binding;
  const local =
    binding.purpose === "security-review" &&
    binding.issue === issue &&
    binding.headSha === headSha &&
    runner.providerType === "claude";
  if (
    !local ||
    !hasKnownReviewAccounts(builder, runner) ||
    !hasKnownReviewAccounts(builder, primaryReviewer) ||
    primaryReviewer.agentId === runner.agentId ||
    !matchesLaunch(issue, headSha, builder, runner, selection)
  )
    return false;
  return builder.accountDefinition === runner.accountDefinition
    ? provesSameAccountFallback(selection)
    : selection.mode === "different-account";
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return (
    right.length > 0 &&
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((path) => isGitPath(path) && right.includes(path))
  );
}

function reviewTimeValid(reviewedAt: string, binding: SecurityReviewBinding): boolean {
  const reviewed = Date.parse(reviewedAt);
  return (
    Number.isFinite(reviewed) &&
    reviewed >= Date.parse(binding.runner.openedAt) &&
    reviewed >= Date.parse(binding.selection.at)
  );
}

/** Read the dedicated runner's own final reply from the daemon. Comment text supplies no evidence. */
export function readSecurityReviewEvidence(
  context: SecurityReviewContext & { reply: string; reviewedAt: string },
): SecurityReviewEvidence | null {
  if (!securityBindingValid(context) || !reviewTimeValid(context.reviewedAt, context.binding))
    return null;
  try {
    const review = securityReply.parse(JSON.parse(context.reply));
    if (review.sha !== context.headSha || !samePaths(review.sensitivePaths, context.sensitivePaths))
      return null;
    return {
      ...review,
      issue: context.issue,
      source: "local-runner",
      reviewer: structuredClone(context.binding.runner),
      sensitivePaths: [...review.sensitivePaths].sort(),
      reviewedAt: context.reviewedAt,
    };
  } catch {
    return null;
  }
}

export function isSecurityReviewApproved(
  review: SecurityReviewEvidence | null,
  context: SecurityReviewContext,
): boolean {
  return Boolean(
    review &&
    review.kind === "security-review" &&
    review.source === "local-runner" &&
    review.approved &&
    review.issue === context.issue &&
    review.sha === context.headSha &&
    review.findings.trim() &&
    samePaths(review.sensitivePaths, context.sensitivePaths) &&
    securityBindingValid(context) &&
    sameRunner(review.reviewer, context.binding.runner) &&
    reviewTimeValid(review.reviewedAt, context.binding),
  );
}
