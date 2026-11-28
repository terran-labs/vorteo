import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { OWNER_ONLY_FILES, type FactoryGitHub } from "../project/claims.js";
import type { DeliveryExecutorDeps, HostGateRecord } from "./delivery/executor.js";
import type { IssueLedger } from "./issue-state.js";
import { createMergeGate, type MergeEvidence, type MergeIntent } from "./merge-gate.js";
import {
  isSecurityReviewApproved,
  proveCleanRebase,
  type CleanRebaseProof,
  type ReviewGitObjects,
  type ReviewLaunchEvidence,
  type SecurityReviewBinding,
  type SecurityReviewEvidence,
} from "./review-evidence.js";
import type { LeanStateStore, RunnerRef } from "./types.js";

const oid = z.string().regex(/^[0-9a-f]{40}$/u);
const object = z.object({ sha: oid });
const branch = z.object({ ref: z.string(), object });
const repositoryInfo = z.object({ full_name: z.string(), default_branch: z.string().min(1) });
const commitInfo = object.extend({ tree: object, parents: z.array(object) });
const repo = z.object({ full_name: z.string() });
const mergedPull = z.object({
  number: z.number().int().positive(),
  merged: z.literal(true),
  merged_at: z.iso.datetime({ offset: true }),
  merge_commit_sha: oid,
  changed_files: z.number().int().positive(),
  head: z.object({ sha: oid, ref: z.string(), repo }),
  base: z.object({ ref: z.string(), repo }),
});
const changedFile = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().min(1).optional(),
  status: z.string(),
});
const comparison = z.object({
  status: z.literal("ahead"),
  merge_base_commit: object,
  files: z.array(changedFile),
});
const treeEntries = object.extend({
  truncated: z.literal(false),
  tree: z.array(object.extend({ path: z.string(), mode: z.string(), type: z.string() })),
});
const blobContents = object.extend({ encoding: z.literal("base64"), content: z.string() });
const config = z.object({
  schema: z.literal("vorteo-factory"),
  version: z.literal(1),
  sensitivePaths: z.array(z.string().min(1)).optional(),
  releaseRecipeFiles: z.array(z.string().min(1)).optional(),
  review: z.object({ allowSameAccount: z.boolean().optional() }).optional(),
});
const protectedFiles = new Set([...OWNER_ONLY_FILES, ".github/vorteo-factory.json"]);
const historyLimit = 256;

interface DeliveryLedger extends IssueLedger {
  mergeIntents?: Record<string, MergeIntent>;
  runtimeMerges?: Record<string, { head: string; mergeSha: string; settled: boolean }>;
  runtimeSecurityReviews?: Record<
    string,
    { binding: SecurityReviewBinding; evidence: SecurityReviewEvidence | null }
  >;
}

export interface DeliveryHostPolicy {
  sensitivePaths: readonly string[];
  releaseRecipeFiles: readonly string[];
  allowSameAccount: boolean;
}

export interface DeliveryHostGateOptions {
  projectId: string;
  repository: string;
  state: LeanStateStore;
  /** The shared authenticated, budgeted GitHub client for this installation. */
  github: FactoryGitHub;
  /** Override only with an authenticated policy reader pinned to the named commit. */
  readPolicy?(commit: string): Promise<DeliveryHostPolicy | null>;
  /** Explicitly trusted installed commit for a project with no successful delivery receipt. */
  initialDeliveredCommit?: string;
  /** Needed for a rebased approval. Use only the daemon's verified object database for this repo. */
  reviewObjects?(proof: CleanRebaseProof): Promise<ReviewGitObjects | null>;
}

function successfulBaseline(ledger: DeliveryLedger, initial: string | undefined): string | null {
  const receipt = ledger.delivery.receipts.findLast((entry) => entry.outcome === "delivered");
  if (!receipt) return oid.safeParse(initial).data ?? null;
  if (receipt.commits.length !== 1) return null;
  const [commit] = receipt.commits;
  return receipt.verification.trim() && Number.isFinite(Date.parse(receipt.verifiedAt))
    ? (oid.safeParse(commit).data ?? null)
    : null;
}

function sameRunner(left: RunnerRef, right: RunnerRef): boolean {
  return (
    left.agentId === right.agentId &&
    left.role === right.role &&
    left.serverId === right.serverId &&
    left.providerType === right.providerType &&
    left.account === right.account &&
    left.accountDefinition === right.accountDefinition &&
    left.openedAt === right.openedAt &&
    left.attempt === right.attempt
  );
}

function pathsOf(files: z.infer<typeof changedFile>[]): string[] | null {
  if (
    new Set(files.map((file) => file.filename)).size !== files.length ||
    files.some((file) => file.status === "renamed" && !file.previous_filename)
  )
    return null;
  return [
    ...new Set(
      files.flatMap(({ filename, previous_filename }) =>
        previous_filename ? [filename, previous_filename] : [filename],
      ),
    ),
  ];
}

function matchingSelection(
  selection: ReviewLaunchEvidence,
  issue: number,
  head: string,
  lead: RunnerRef,
  reviewer: RunnerRef,
  allowSameAccount: boolean,
): boolean {
  return (
    selection.issue === issue &&
    selection.headSha === head &&
    selection.builderAgentId === lead.agentId &&
    selection.builderAccount === lead.account &&
    selection.builderAccountDefinition === lead.accountDefinition &&
    selection.reviewerAgentId === reviewer.agentId &&
    selection.reviewerAccount === reviewer.account &&
    selection.reviewerAccountDefinition === reviewer.accountDefinition &&
    selection.daemonCreated === true &&
    selection.clean === true &&
    selection.nonChild === true &&
    selection.freshSession === true &&
    Number.isFinite(Date.parse(selection.at)) &&
    (lead.accountDefinition === reviewer.accountDefinition
      ? allowSameAccount && selection.mode === "same-account"
      : selection.mode === "different-account")
  );
}

function exactLocalReview(ledger: DeliveryLedger, intent: MergeIntent, policy: DeliveryHostPolicy) {
  const { issue, approval } = intent;
  const { lead, reviewer, verdict, acceptance, acceptanceSession, reviewAccountSelection } =
    approval;
  const head = approval.rebaseProof?.prior.headSha ?? intent.headSha;
  if (
    !lead ||
    !reviewer ||
    !verdict ||
    !acceptance ||
    !acceptanceSession ||
    !reviewAccountSelection
  )
    return null;

  const isBoundVerdict = (candidate: typeof verdict | undefined) =>
    candidate?.source === "local-runner" &&
    candidate.approved === true &&
    candidate.sha === head &&
    sameRunner(candidate.reviewer, reviewer);
  if (
    reviewer.providerType !== "claude" ||
    ![verdict, ledger.localVerdicts?.[issue]].every(isBoundVerdict)
  )
    return null;
  const allBound = [lead, reviewer, acceptanceSession].every((runner) => {
    const saved = ledger.runners[runner.agentId];
    return saved?.issue === issue && runner.serverId === null && sameRunner(saved, runner);
  });
  const recorded: RunnerRef & { reviewAccountSelection?: ReviewLaunchEvidence } =
    ledger.runners[reviewer.agentId];
  if (
    !allBound ||
    !isDeepStrictEqual(reviewAccountSelection, recorded.reviewAccountSelection) ||
    !matchingSelection(
      reviewAccountSelection,
      issue,
      head,
      lead,
      reviewer,
      policy.allowSameAccount,
    ) ||
    !ledger.acceptances[issue]?.some((entry) => isDeepStrictEqual(entry, acceptance))
  )
    return null;
  return {
    lead,
    reviewer,
    acceptanceSession,
    acceptedAt: Date.parse(acceptance.at),
    selectedAt: Date.parse(reviewAccountSelection.at),
  };
}

function settledIntent(
  ledger: DeliveryLedger,
  landed: z.infer<typeof commitInfo>,
): MergeIntent | null {
  const records = Object.entries(ledger.runtimeMerges ?? {}).filter(
    ([, saved]) => saved.settled === true && saved.mergeSha === landed.sha,
  );
  if (records.length !== 1 || landed.parents.length > 2) return null;
  const [[issueKey, saved]] = records;
  const issue = Number(issueKey);
  if (!Number.isSafeInteger(issue) || issue < 1 || !oid.safeParse(saved.head).success) return null;
  const intents = Object.values(ledger.mergeIntents ?? {}).filter(
    (intent) => intent.issue === issue && intent.headSha === saved.head,
  );
  if (intents.length !== 1) return null;
  const [intent] = intents;
  const intentKey = JSON.stringify([issue, intent.number, intent.headSha]);
  if (
    !Number.isSafeInteger(intent.number) ||
    intent.number < 1 ||
    ledger.mergeIntents?.[intentKey] !== intent ||
    (landed.parents.length === 2 && landed.parents[1].sha !== intent.headSha)
  )
    return null;
  return intent;
}

function securityPassed(
  ledger: DeliveryLedger,
  intent: MergeIntent,
  policy: DeliveryHostPolicy,
  local: NonNullable<ReturnType<typeof exactLocalReview>>,
  paths: string[],
  mergedBefore: number,
): boolean {
  const sensitivePaths = paths.filter((file) =>
    policy.sensitivePaths.some((pattern) => matchesGlob(file, pattern)),
  );
  if (!sensitivePaths.length) return true;
  const security = ledger.runtimeSecurityReviews?.[intent.issue];
  return Boolean(
    security &&
    Date.parse(security.evidence?.reviewedAt ?? "") < mergedBefore &&
    security.binding.runner.agentId !== local.acceptanceSession.agentId &&
    (security.binding.selection.mode !== "same-account" || policy.allowSameAccount) &&
    isSecurityReviewApproved(security.evidence, {
      issue: intent.issue,
      headSha: intent.headSha,
      sensitivePaths,
      builder: local.lead,
      primaryReviewer: local.reviewer,
      binding: security.binding,
    }),
  );
}

/** Reuse the merge gate's approval rules with the historical evidence and no write ports. */
async function validatedIntent(
  intent: MergeIntent,
  evidence: Extract<MergeEvidence, { kind: "merged" }>,
) {
  const result = await createMergeGate({
    here: "",
    read: async () => evidence,
    currentMergeEpoch: async () => 1,
    fenceMerge: async () => true,
    readIntent: async (target) =>
      target.issue === intent.issue &&
      target.number === intent.number &&
      target.headSha === intent.headSha
        ? intent
        : null,
    recordIntent: async () => {
      throw new Error("The delivery gate cannot record a merge intent.");
    },
    submit: async () => {
      throw new Error("The delivery gate cannot submit a merge.");
    },
    complete: async () => ({ done: true }),
  }).recoverMerged(intent.issue, evidence.pull);
  return "mergeSha" in result && result.mergeSha === evidence.mergeSha;
}

export function createLeanDeliveryHostGate(
  options: DeliveryHostGateOptions,
): DeliveryExecutorDeps["hostGate"] {
  const { state, projectId, repository, github } = options;
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/iu.test(repository))
    throw new Error("Delivery requires a valid GitHub repository.");
  const sameRepository = (name: string) => name.toLowerCase() === repository.toLowerCase();

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const route = `repos/${repository}` + (path ? `/${path}` : "");
    const response = await github.rest("GET", route);
    if (response.status !== 200) throw new Error("GitHub could not verify the delivery history.");
    return schema.parse(response.body);
  }

  async function defaultBranch() {
    const info = await get("", repositoryInfo);
    if (!sameRepository(info.full_name)) throw new Error("The delivery repository changed.");
    const name = info.default_branch;
    const ref = await get(
      `git/ref/heads/${name.split("/").map(encodeURIComponent).join("/")}`,
      branch,
    );
    if (ref.ref !== `refs/heads/${name}`) throw new Error("The delivery branch changed.");
    return { name, head: ref.object.sha };
  }

  async function readCommit(sha: string) {
    const result = await get(`git/commits/${sha}`, commitInfo);
    if (result.sha !== sha) throw new Error("GitHub returned the wrong commit.");
    return result;
  }

  async function readPolicy(commit: string): Promise<DeliveryHostPolicy | null> {
    if (options.readPolicy) return options.readPolicy(commit);
    async function entry(treeOid: string, path: string) {
      const tree = await get(`git/trees/${treeOid}`, treeEntries);
      const matches = tree.tree.filter((candidate) => candidate.path === path);
      return tree.sha === treeOid && matches.length === 1 ? matches[0] : null;
    }
    const parent = await readCommit(commit);
    const directory = await entry(parent.tree.sha, ".github");
    if (directory?.type !== "tree" || directory.mode !== "040000") return null;
    const file = await entry(directory.sha, "vorteo-factory.json");
    if (file?.type !== "blob" || file.mode !== "100644") return null;
    const blob = await get(`git/blobs/${file.sha}`, blobContents);
    const bytes = Buffer.from(blob.content, "base64");
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (blob.sha !== file.sha || actual !== file.sha) return null;
    const policy = config.parse(JSON.parse(bytes.toString("utf8")));
    return {
      sensitivePaths: policy.sensitivePaths ?? [],
      releaseRecipeFiles: policy.releaseRecipeFiles ?? [],
      allowSameAccount: policy.review?.allowSameAccount === true,
    };
  }

  async function pullPaths(pull: z.infer<typeof mergedPull>) {
    if (pull.changed_files >= 3000) return null; // GitHub truncates the pull files endpoint at 3000.
    const files: z.infer<typeof changedFile>[] = [];
    for (let page = 1; files.length < pull.changed_files; page++) {
      const rows = await get(
        `pulls/${pull.number}/files?per_page=100&page=${page}`,
        z.array(changedFile),
      );
      if (rows.length !== Math.min(100, pull.changed_files - files.length)) return null;
      files.push(...rows);
    }
    return pathsOf(files);
  }

  async function boundPull(
    intent: MergeIntent,
    landed: z.infer<typeof commitInfo>,
    baseBranch: string,
  ) {
    const [pull, reviewed] = await Promise.all([
      get(`pulls/${intent.number}`, mergedPull),
      readCommit(intent.headSha),
    ]);
    if (
      pull.number !== intent.number ||
      pull.merge_commit_sha !== landed.sha ||
      pull.head.sha !== intent.headSha ||
      pull.head.ref !== `factory/issue-${intent.issue}` ||
      pull.base.ref !== baseBranch ||
      !sameRepository(pull.head.repo.full_name) ||
      !sameRepository(pull.base.repo.full_name) ||
      reviewed.tree.sha !== landed.tree.sha
    )
      return null;
    return pull;
  }

  async function verifyRebase(intent: MergeIntent, firstParent: string, landedTree: string) {
    const proof = intent.approval.rebaseProof;
    if (!proof) return true;
    if (proof.current.baseSha !== firstParent || proof.resultingTree !== landedTree) return false;
    const objects = await options.reviewObjects?.(proof);
    if (!objects) return false;
    const result = await proveCleanRebase(objects, proof.prior, proof.current);
    return result.proved && isDeepStrictEqual(result.proof, proof);
  }

  async function changedPaths(pull: z.infer<typeof mergedPull>, firstParent: string) {
    const [diff, files] = await Promise.all([
      get(`compare/${firstParent}...${pull.head.sha}?per_page=1`, comparison),
      pullPaths(pull),
    ]);
    // The identical trees and verified ancestor make this range the landed first-parent delta.
    if (diff.merge_base_commit.sha !== firstParent || diff.files.length >= 300 || !files)
      return null;
    const landedPaths = pathsOf(diff.files);
    return landedPaths?.length ? [...new Set([...files, ...landedPaths])].sort() : null;
  }

  async function checkMerge(
    ledger: DeliveryLedger,
    landed: z.infer<typeof commitInfo>,
    baseBranch: string,
  ): Promise<boolean> {
    const firstParent = landed.parents[0]?.sha;
    const intent = settledIntent(ledger, landed);
    if (!intent || !firstParent) return false;
    const [policy, pull] = await Promise.all([
      readPolicy(firstParent),
      boundPull(intent, landed, baseBranch),
    ]);
    if (!pull || !policy) return false;
    const local = exactLocalReview(ledger, intent, policy);
    // GitHub omits sub-second precision on merge timestamps.
    const mergedBefore = Date.parse(pull.merged_at) + 1000;
    if (
      !local ||
      ![
        Date.parse(local.acceptanceSession.openedAt),
        Date.parse(local.reviewer.openedAt),
        local.selectedAt,
      ].every((start) => start <= local.acceptedAt && local.acceptedAt < mergedBefore)
    )
      return false;
    const approved = await validatedIntent(intent, {
      kind: "merged",
      mergeSha: landed.sha,
      pull: {
        number: intent.number,
        headSha: intent.headSha,
        checks: "pending",
        sameRepo: true,
        targetsDefaultBranch: true,
        branch: pull.head.ref,
      },
    });
    if (!approved || !(await verifyRebase(intent, firstParent, landed.tree.sha))) return false;
    const paths = await changedPaths(pull, firstParent);
    if (
      !paths ||
      paths.some(
        (file) =>
          protectedFiles.has(file) ||
          file.startsWith(".github/workflows/") ||
          policy.releaseRecipeFiles.includes(file),
      )
    )
      return false;
    return securityPassed(ledger, intent, policy, local, paths, mergedBefore);
  }

  return async (commit): Promise<HostGateRecord | null> => {
    if (!oid.safeParse(commit).success) return null;
    try {
      const ledger: DeliveryLedger = await state.read(projectId);
      const baseline = successfulBaseline(ledger, options.initialDeliveredCommit);
      if (!baseline) return null;
      const initial = await defaultBranch();
      let next = initial.head;
      let reachedTarget = false;
      for (let count = 0; next !== baseline; count++) {
        if (count === historyLimit) return null;
        if (next === commit) reachedTarget = true;
        const landed = await readCommit(next);
        const parent = landed.parents[0]?.sha;
        if (!parent || (reachedTarget && !(await checkMerge(ledger, landed, initial.name))))
          return null;
        next = parent;
      }
      if (!reachedTarget && commit !== baseline) return null;
      // A receipt proves delivery, which can also happen entirely in a container.
      if (
        commit === baseline &&
        options.initialDeliveredCommit !== baseline &&
        !(await checkMerge(ledger, await readCommit(baseline), initial.name))
      )
        return null;
      if (!isDeepStrictEqual(initial, await defaultBranch())) return null;
      const passed = { passed: true, sha: commit };
      return { commit, trust: passed, verdict: passed, ownerOnly: passed };
    } catch {
      // Failed GitHub reads, malformed ledger evidence, and policy failures all deny execution.
      return null;
    }
  };
}
