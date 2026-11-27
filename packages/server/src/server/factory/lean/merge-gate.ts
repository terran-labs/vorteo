import type { ReviewAccountSelection } from "./accounts.js";
import type {
  Acceptance,
  AdmissionFacts,
  Lease,
  MergeGate,
  PullRef,
  RunnerRef,
  Verdict,
} from "./types.js";

interface MergePull extends PullRef {
  /** Passing requires all configured required checks and no configured extra check failures. */
  checks: PullRef["checks"];
  branch: string;
  sameRepo: boolean;
  targetsDefaultBranch: boolean;
}

interface OpenMergeEvidence {
  reviewAccountSelection?: ReviewAccountSelection;
  kind: "open";
  pull: MergePull;
  trust: AdmissionFacts["trust"];
  blocked: boolean;
  /** Live, verified lease for this issue, calculated on the reader's clock. */
  lease: Lease | null;
  ownerOnly: { checkedHeadSha: string | null; touched: readonly string[] };
  checksHeadSha: string | null;
  trustedThreadsOpen: number;
  mergeable: boolean | null;
  /** Issue-scoped lead record for this head, including closed runners, from the daemon ledger. */
  lead: RunnerRef | null;
  /** Ledger binding for the reviewer opened for this issue and head. */
  reviewer: RunnerRef | null;
  /** Verdict parsed from the bound reviewer's own last assistant reply. */
  verdict: Verdict | null;
  /** Latest issue-scoped local acceptance ledger entry for this head. */
  acceptance: Acceptance | null;
  /** Ledger binding for the operational session that recorded the acceptance for this issue. */
  acceptanceSession: RunnerRef | null;
}

interface MergedEvidence {
  kind: "merged";
  pull: MergePull;
  /** GitHub's recorded merge commit after proving it is on the current default branch. */
  mergeSha: string;
}

export type MergeEvidence =
  | OpenMergeEvidence
  | MergedEvidence
  | { kind: "queued"; pull: MergePull }
  | { kind: "unavailable"; reason: string };

interface MergeTarget {
  issue: number;
  number: number;
  headSha: string;
}

interface MergeCompletion extends MergeTarget {
  mergeSha: string;
  epoch: number;
}

type ApprovalEvidence = Pick<
  OpenMergeEvidence,
  "lead" | "reviewer" | "verdict" | "acceptance" | "acceptanceSession" | "reviewAccountSelection"
>;

/** The daemon's immutable authorization for one exact submission target. */
export interface MergeIntent extends MergeTarget {
  approval: ApprovalEvidence;
}

type MergeResult = { mergeSha: string } | { refused: string; code?: "merge-inconsistent" };
type MergeEvaluation = Awaited<ReturnType<MergeGate["evaluate"]>>;
type SubmitResult =
  | { kind: "submitted" }
  | { kind: "queued" }
  | { kind: "refused"; reason: string };

export interface MergeGateDeps {
  here: string;
  /** Fresh evidence for the uniquely linked claim PR. Unknown or ambiguous evidence fails closed. */
  read(issue: number): Promise<MergeEvidence>;
  currentMergeEpoch(): Promise<number | null>;
  fenceMerge(epoch: number): Promise<boolean>;
  /** Read the exact target from validated, daemon-owned durable storage. */
  readIntent(target: MergeTarget): Promise<MergeIntent | null>;
  /**
   * Durably persist before returning success. Atomically keep the first intent for this
   * issue, PR and head, accepting identical retries and refusing conflicting approvals.
   * Fence the supplied epoch immediately before writing.
   */
  recordIntent(
    intent: MergeIntent,
    epoch: number,
  ): Promise<{ done: true } | { done: false; reason: string }>;
  /** Use GitHub's atomic expected head parameter for both direct merges and queue submission. */
  submit(target: MergeTarget): Promise<SubmitResult>;
  /**
   * Idempotently record the merge, close the issue and release its matching lease. Re-fence
   * before each write, including on retries after any write succeeded.
   */
  complete(merge: MergeCompletion): Promise<{ done: true } | { done: false; reason: string }>;
}

export interface RecoverableMergeGate extends MergeGate {
  merge(issue: number, pr: PullRef, verdict: Verdict, acceptance: Acceptance): Promise<MergeResult>;
  /** Resume bookkeeping after GitHub confirmed a merge, including after a daemon restart. */
  recoverMerged(issue: number, pr: PullRef): Promise<MergeResult>;
}

function claimPull(issue: number, pull: MergePull): boolean {
  return pull.sameRepo && pull.targetsDefaultBranch && pull.branch === `factory/issue-${issue}`;
}

function evaluateOpen(issue: number, here: string, evidence: OpenMergeEvidence): MergeEvaluation {
  const { pull, trust, lease, ownerOnly } = evidence;
  if (!trust.trusted) return { ready: false, waitingOn: trust.reason };
  if (!claimPull(issue, pull)) {
    return {
      ready: false,
      waitingOn: "Use the claim branch in this repository and target the default branch.",
    };
  }
  if (!lease || lease.released || lease.issue !== issue || lease.branch !== pull.branch) {
    return { ready: false, waitingOn: "Wait for a live lease on the claim branch." };
  }
  if (ownerOnly.checkedHeadSha !== pull.headSha) {
    return { ready: false, waitingOn: "Check the current head for owner-only changes." };
  }
  if (ownerOnly.touched.length > 0) {
    return { ready: false, waitingOn: "Remove the owner-only changes from this pull request." };
  }
  if (evidence.checksHeadSha !== pull.headSha || pull.checks !== "passing") {
    return { ready: false, waitingOn: "Wait for passing checks on the current head." };
  }
  if (evidence.blocked) return { ready: false, waitingOn: "Resolve the Factory block first." };
  if (evidence.trustedThreadsOpen !== 0) {
    return { ready: false, waitingOn: "Resolve the outstanding trusted review threads." };
  }
  if (evidence.mergeable !== true) {
    return { ready: false, waitingOn: "Wait for GitHub to confirm the pull request is mergeable." };
  }
  return evaluateApprovals(issue, pull, evidence, lease.installation === here);
}

function sameAccountReview(
  issue: number,
  head: string,
  lead: RunnerRef,
  reviewer: RunnerRef,
  selection?: ReviewAccountSelection,
): boolean {
  if (
    !selection ||
    selection.mode !== "same-account" ||
    selection.issue !== issue ||
    selection.headSha !== head
  )
    return false;
  if (
    selection.builderAgentId !== lead.agentId ||
    selection.reviewerAgentId !== reviewer.agentId ||
    selection.builderAccountDefinition !== lead.accountDefinition ||
    selection.reviewerAccountDefinition !== reviewer.accountDefinition ||
    selection.builderAccount !== lead.account ||
    selection.reviewerAccount !== reviewer.account
  )
    return false;
  if (
    !selection.daemonCreated ||
    !selection.clean ||
    !selection.nonChild ||
    !selection.freshSession ||
    !Number.isFinite(Date.parse(selection.at))
  )
    return false;
  const chosen = selection.candidates.filter((candidate) => candidate.reason === "selected");
  const exclusions = new Set([
    "profile-bound",
    "not-allowed",
    "wrong-provider",
    "unavailable-on-destination",
    "parked",
    "exhausted",
  ]);
  return (
    chosen.length === 1 &&
    chosen[0].accountDefinition === reviewer.accountDefinition &&
    selection.candidates.every(
      (candidate) =>
        candidate === chosen[0] ||
        exclusions.has(candidate.reason) ||
        (candidate.reason === "builder-account" &&
          candidate.accountDefinition === lead.accountDefinition),
    )
  );
}

function independentReview(
  issue: number,
  head: string,
  lead: RunnerRef | null,
  reviewer: RunnerRef,
  selection?: ReviewAccountSelection,
): boolean {
  return (
    lead?.role === "lead" &&
    reviewer.role === "reviewer" &&
    lead.agentId !== reviewer.agentId &&
    Boolean(lead.accountDefinition) &&
    Boolean(reviewer.accountDefinition) &&
    (lead.accountDefinition !== reviewer.accountDefinition ||
      sameAccountReview(issue, head, lead, reviewer, selection))
  );
}

function acceptedByForeman(headSha: string, evidence: ApprovalEvidence): Acceptance | null {
  const { acceptance, acceptanceSession, lead, reviewer } = evidence;
  const acceptedHead = acceptance?.outcome === "accepted" && acceptance.sha === headSha;
  const localSession =
    acceptance?.source === "local-session" &&
    acceptanceSession?.role === "foreman-op" &&
    acceptance.session === acceptanceSession.agentId;
  const distinctSession =
    acceptanceSession?.agentId !== reviewer?.agentId &&
    acceptanceSession?.agentId !== lead?.agentId;
  return acceptedHead && localSession && distinctSession ? acceptance : null;
}

function evaluateApprovals(
  issue: number,
  pull: PullRef,
  evidence: ApprovalEvidence,
  localLease: boolean,
): MergeEvaluation {
  const { lead, reviewer, verdict } = evidence;
  if (!verdict || !verdict.approved || verdict.sha !== pull.headSha) {
    return { ready: false, waitingOn: "Get reviewer approval for the current head." };
  }
  const localReview = localLease && verdict.source === "local-runner";
  const boundReviewer = reviewer?.agentId === verdict.reviewer.agentId;
  if (
    !localReview ||
    !reviewer ||
    !boundReviewer ||
    !independentReview(issue, pull.headSha, lead, reviewer, evidence.reviewAccountSelection)
  ) {
    return {
      ready: false,
      waitingOn:
        "Get an independent local review and record account selection when the Reviewer shares the Builder's account.",
    };
  }
  const acceptance = acceptedByForeman(pull.headSha, evidence);
  if (!acceptance) {
    return {
      ready: false,
      waitingOn: "Get acceptance for the current commit from a separate Lead session.",
    };
  }
  const pr = { number: pull.number, headSha: pull.headSha, checks: pull.checks };
  return { ready: true, pr, verdict: { ...verdict, reviewer }, acceptance };
}

function waitingOn(evidence: Exclude<MergeEvidence, OpenMergeEvidence>): string {
  switch (evidence.kind) {
    case "merged":
      return "GitHub already merged this pull request.";
    case "queued":
      return "Wait for GitHub's merge queue to finish.";
    case "unavailable":
      return evidence.reason;
  }
}

function matches(pull: MergePull, target: MergeTarget): boolean {
  return (
    claimPull(target.issue, pull) &&
    pull.number === target.number &&
    pull.headSha === target.headSha
  );
}

function inconsistent(): MergeResult {
  return {
    code: "merge-inconsistent",
    refused:
      "GitHub reports a merge that Factory cannot match to its recorded approval. Ask the owner to reconcile the issue before closing it.",
  };
}

export function createMergeGate(deps: MergeGateDeps): RecoverableMergeGate {
  const laneUnavailable = "Wait until this installation holds the merge lane.";

  async function finish(
    target: MergeTarget,
    evidence: MergeEvidence,
    epoch: number,
  ): Promise<MergeResult> {
    if (evidence.kind !== "merged") {
      return {
        refused:
          "Wait for GitHub to confirm this exact pull request head merged into the default branch.",
      };
    }
    if (!matches(evidence.pull, target)) return inconsistent();
    const intent = await deps.readIntent(target);
    const sameTarget =
      intent?.issue === target.issue &&
      intent.number === target.number &&
      intent.headSha === target.headSha;
    if (
      !intent ||
      !sameTarget ||
      !evaluateApprovals(target.issue, evidence.pull, intent.approval, true).ready
    ) {
      return inconsistent();
    }
    if (!(await deps.fenceMerge(epoch))) return { refused: laneUnavailable };
    const result = await deps.complete({ ...target, mergeSha: evidence.mergeSha, epoch });
    if (!result.done) return { refused: result.reason };
    return { mergeSha: evidence.mergeSha };
  }

  return {
    async evaluate(issue) {
      const epoch = await deps.currentMergeEpoch();
      if (epoch === null) return { ready: false, waitingOn: laneUnavailable };
      const evidence = await deps.read(issue);
      if (evidence.kind !== "open") return { ready: false, waitingOn: waitingOn(evidence) };
      return evaluateOpen(issue, deps.here, evidence);
    },

    async merge(issue, pr, verdict, acceptance) {
      const epoch = await deps.currentMergeEpoch();
      if (epoch === null) return { refused: laneUnavailable };
      const target = { issue, number: pr.number, headSha: pr.headSha };
      const evidence = await deps.read(issue);
      if (evidence.kind === "merged") return finish(target, evidence, epoch);
      if (evidence.kind !== "open") return { refused: waitingOn(evidence) };
      if (!matches(evidence.pull, target)) {
        return { refused: "The claim pull request or its head changed. Reconcile it again." };
      }
      const current = evaluateOpen(issue, deps.here, evidence);
      if (!current.ready) return { refused: current.waitingOn };
      const sameReview =
        verdict.sha === current.verdict.sha &&
        verdict.reviewer.agentId === current.verdict.reviewer.agentId;
      const sameAcceptance =
        acceptance.sha === current.acceptance.sha &&
        acceptance.session === current.acceptance.session &&
        acceptance.at === current.acceptance.at;
      if (!sameReview || !sameAcceptance) {
        return { refused: "The approval evidence changed. Reconcile it again." };
      }
      if (!(await deps.fenceMerge(epoch))) return { refused: laneUnavailable };
      const recorded = await deps.recordIntent(
        {
          ...target,
          approval: {
            lead: evidence.lead,
            reviewer: current.verdict.reviewer,
            verdict: current.verdict,
            acceptance: current.acceptance,
            acceptanceSession: evidence.acceptanceSession,
            ...(evidence.reviewAccountSelection
              ? { reviewAccountSelection: evidence.reviewAccountSelection }
              : {}),
          },
        },
        epoch,
      );
      if (!recorded.done) return { refused: recorded.reason };
      if (!(await deps.fenceMerge(epoch))) return { refused: laneUnavailable };
      const result = await deps.submit(target);
      if (result.kind === "refused") return { refused: result.reason };
      if (result.kind === "queued") return { refused: "Wait for GitHub's merge queue to finish." };
      return finish(target, await deps.read(issue), epoch);
    },

    async recoverMerged(issue, pr) {
      const epoch = await deps.currentMergeEpoch();
      if (epoch === null) return { refused: laneUnavailable };
      const target = { issue, number: pr.number, headSha: pr.headSha };
      return finish(target, await deps.read(issue), epoch);
    },
  };
}
