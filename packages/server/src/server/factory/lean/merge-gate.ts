import type { ReviewAccountSelection } from "./accounts.js";
import { foreignReviewIndependence, type ReviewIndependence } from "./machines/roles.js";
import {
  foreignReviewLaunchMatches,
  recordedForeignAccountExclusions,
  reviewerVerdictDigest,
  type RecordedForeignReview,
  type CleanRebaseProof,
  type ForeignReviewLaunchEvidence,
  type HostSubmissionProof,
} from "./review-evidence.js";
import { isDeepStrictEqual } from "node:util";
import { LEAN_PROTOCOL_MAJOR } from "./types.js";
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
  /** Produced by the daemon's Git object verifier, never by a runner. */
  rebaseProof?: CleanRebaseProof;
  reviewAccountSelection?: ReviewAccountSelection;
  reviewPolicy?: MergeReviewPolicy;
  foreignReview?: ForeignMergeReview;
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

export interface MergeReviewPolicy {
  /** Immutable default-branch commit used to resolve the owner policy. */
  configCommit: string;
  providerType: string;
  /** Present only after verifying the owner explicitly selected Host for this config commit. */
  placement?: "host";
  allowForeignSameProvider?: boolean;
}

interface SignedSubmission {
  installation: string;
  generation: string;
  head: string;
  builderProviderType: string;
}

export interface ForeignMergeReview {
  submission: Omit<SignedSubmission, "builderProviderType"> & { builderProviderType?: string };
  /** Supplied only by the primary Host's independent exact-head verifier. */
  hostProof?: HostSubmissionProof;
  launch: ForeignReviewLaunchEvidence;
  /** Persisted atomically with the first verdict parsed from this Reviewer's private reply. */
  readonly recorded?: RecordedForeignReview;
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
  foreignSubmission?: SignedSubmission;
  hostProof?: HostSubmissionProof;
}

type ApprovalEvidence = Pick<
  OpenMergeEvidence,
  | "lead"
  | "reviewer"
  | "verdict"
  | "acceptance"
  | "acceptanceSession"
  | "reviewAccountSelection"
  | "reviewPolicy"
  | "foreignReview"
  | "rebaseProof"
>;

/** The daemon's immutable authorization for one exact submission target. */
export interface MergeIntent extends MergeTarget {
  approval: ApprovalEvidence;
  /** Required for new foreign intents. Older local intents did not record independence. */
  foreignIndependence?: ReviewIndependence;
  hostGate?: { primary: string; trustedHead: string; protectedPathsCheckedHead: string };
}

type MergeResult = { mergeSha: string } | { refused: string; code?: "merge-inconsistent" };
type MergeEvaluation = Awaited<ReturnType<MergeGate["evaluate"]>>;
type EvaluatedApproval = MergeEvaluation & { foreignIndependence?: ReviewIndependence };
type ApprovedMerge = Extract<EvaluatedApproval, { ready: true }>;
type SubmitResult =
  | { kind: "submitted" }
  | { kind: "queued" }
  | { kind: "refused"; reason: string };

export interface MergeGateDeps {
  here: string;
  /** Enabled by the runtime once it reads the pinned owner review policy for each open PR. */
  requirePinnedReviewerPolicy?: true;
  /** Machine mode whose claim refs only coordinate dispatch. */
  requireIndependentHostProof?: true;
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
  submit(
    target: MergeTarget,
    expectedForeign?: SignedSubmission,
    expectedHost?: HostSubmissionProof,
  ): Promise<SubmitResult>;
  /**
   * Idempotently record the merge, close the issue and release its matching lease. Re-fence
   * before each write, including on retries after any write succeeded.
   */
  complete(merge: MergeCompletion): Promise<{ done: true } | { done: false; reason: string }>;
}

export interface RecoverableMergeGate extends MergeGate {
  evaluate(issue: number): Promise<EvaluatedApproval>;
  merge(issue: number, pr: PullRef, verdict: Verdict, acceptance: Acceptance): Promise<MergeResult>;
  /** Resume bookkeeping after GitHub confirmed a merge, including after a daemon restart. */
  recoverMerged(issue: number, pr: PullRef): Promise<MergeResult>;
}

function claimPull(issue: number, pull: MergePull): boolean {
  return pull.sameRepo && pull.targetsDefaultBranch && pull.branch === `factory/issue-${issue}`;
}

function evaluateOpen(issue: number, here: string, evidence: OpenMergeEvidence): EvaluatedApproval {
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
  if (!matchesLeaseReview(here, evidence, lease)) {
    return {
      ready: false,
      waitingOn: "Verify the foreign submission for the current head.",
    };
  }
  return evaluateApprovals(issue, pull, evidence, here);
}

function matchesLeaseReview(here: string, evidence: OpenMergeEvidence, lease: Lease): boolean {
  if (lease.installation === here) return evidence.foreignReview === undefined;
  const submission = evidence.foreignReview?.submission;
  return (
    lease.protocol === LEAN_PROTOCOL_MAJOR &&
    submission?.installation === lease.installation &&
    Boolean(submission.generation) &&
    submission.head === evidence.pull.headSha
  );
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

function acceptedByForeman(
  headSha: string,
  evidence: ApprovalEvidence,
  here: string,
): Acceptance | null {
  const { acceptance, acceptanceSession, lead, reviewer } = evidence;
  const acceptedHead = acceptance?.outcome === "accepted" && acceptance.sha === headSha;
  const localSession =
    acceptance?.source === "local-session" &&
    acceptanceSession?.role === "foreman-op" &&
    (!evidence.foreignReview || acceptanceSession.serverId === null) &&
    (!evidence.foreignReview?.hostProof || acceptanceSession.installation === here) &&
    acceptance.session === acceptanceSession.agentId;
  const distinctSession =
    acceptanceSession?.agentId !== reviewer?.agentId &&
    acceptanceSession?.agentId !== lead?.agentId;
  return acceptedHead && localSession && distinctSession ? acceptance : null;
}

function reviewedHead(issue: number, pull: PullRef, evidence: ApprovalEvidence): string {
  const proof = evidence.rebaseProof;
  if (
    !proof ||
    proof.current.issue !== issue ||
    proof.current.pullNumber !== pull.number ||
    proof.current.headSha !== pull.headSha ||
    proof.current.checksHeadSha !== pull.headSha ||
    proof.current.checks !== "passing" ||
    proof.prior.issue !== issue ||
    proof.prior.pullNumber !== pull.number
  )
    return pull.headSha;
  const prior = proof.prior;
  if (
    !isDeepStrictEqual(prior.verdict, evidence.verdict) ||
    !isDeepStrictEqual(prior.acceptance, evidence.acceptance) ||
    prior.builder.agentId !== evidence.lead?.agentId ||
    prior.reviewer.agentId !== evidence.reviewer?.agentId ||
    prior.acceptanceSession.agentId !== evidence.acceptanceSession?.agentId
  )
    return pull.headSha;
  return prior.headSha;
}

/** Derive the exact outcome before atomically retaining the Host verdict and its evidence. */
export function recordForeignReview(
  issue: number,
  pull: PullRef,
  evidence: ApprovalEvidence,
  here: string,
): RecordedForeignReview | null {
  const result = assessForeignReview(issue, pull, evidence, here);
  return "independence" in result ? result : null;
}

export function evaluateForeignReview(
  issue: number,
  pull: PullRef,
  evidence: ApprovalEvidence,
  here: string,
): ReviewIndependence | null {
  const result = recordForeignReview(issue, pull, evidence, here);
  return result && recordedForeignReviewMatches(evidence, result) ? result.independence : null;
}

function recordedForeignReviewMatches(evidence: ApprovalEvidence, expected: RecordedForeignReview) {
  return (
    evidence.verdict?.approved === true &&
    isDeepStrictEqual(evidence.foreignReview?.recorded, expected)
  );
}

function assessForeignReview(
  issue: number,
  pull: PullRef,
  evidence: ApprovalEvidence,
  here: string,
): RecordedForeignReview | { refused: string } {
  const { reviewer, verdict, reviewPolicy, foreignReview } = evidence;
  if (!reviewPolicy || !foreignReview || !reviewer || !verdict)
    return { refused: "Get a verified Reviewer verdict under the pinned owner policy." };
  if (reviewPolicy.placement !== "host")
    return { refused: "Set runners.placement to host in the owner Factory configuration." };
  if (!isHostReview(reviewer, verdict, here))
    return { refused: "Use a clean Reviewer assigned to this primary Host." };
  if (!reviewMatchesPolicy(reviewPolicy, reviewer, verdict))
    return { refused: "Get the verdict from the recorded Reviewer on the pinned provider." };
  const { submission, launch, hostProof } = foreignReview;
  if (submission.head !== pull.headSha || verdict.sha !== pull.headSha)
    return { refused: "Get a verified submission and review for the exact pull request head." };
  if (!foreignReviewLaunchMatches(launch, reviewer, issue, pull.headSha, submission.generation))
    return { refused: "Reconcile the Reviewer's recorded launch with this build and head." };
  if (hostProof && !matchesHostSubmission(issue, pull, reviewPolicy, foreignReview, hostProof))
    return { refused: "Reverify the exact pull request and approved plan on the primary Host." };
  const independence = classifyForeignReview(foreignReview, reviewPolicy);
  if (!independence)
    return { refused: "Record valid account exclusions before accepting this foreign review." };
  return {
    independence,
    configCommit: reviewPolicy.configCommit,
    submission: { ...submission },
    verdictDigest: reviewerVerdictDigest(verdict),
    ...(hostProof ? { hostProof: { ...hostProof } } : {}),
  };
}

function matchesHostSubmission(
  issue: number,
  pull: PullRef,
  policy: MergeReviewPolicy,
  review: ForeignMergeReview,
  proof: HostSubmissionProof,
): boolean {
  const { submission, launch } = review;
  return (
    proof.issue === issue &&
    proof.pullNumber === pull.number &&
    proof.head === pull.headSha &&
    proof.installation === submission.installation &&
    proof.generation === submission.generation &&
    proof.configCommit === policy.configCommit &&
    proof.builderProviderType === submission.builderProviderType &&
    /^[a-f0-9]{40}$/.test(proof.baseSha) &&
    /^[a-f0-9]{64}$/.test(proof.planRevision) &&
    Boolean(proof.repository) &&
    isDeepStrictEqual(launch.hostProof, proof)
  );
}

function classifyForeignReview(
  review: ForeignMergeReview,
  policy: MergeReviewPolicy,
): ReviewIndependence | null {
  const exclusions = recordedForeignAccountExclusions(review.launch);
  const provider = review.submission.builderProviderType;
  if (provider)
    return foreignReviewIndependence(
      { ...review.submission, builderProviderType: provider },
      policy.providerType,
      exclusions,
      policy.allowForeignSameProvider,
    );
  return review.hostProof && exclusions && policy.allowForeignSameProvider !== false
    ? "unverified-foreign"
    : null;
}

function signedSubmission(review: ForeignMergeReview | undefined): SignedSubmission | undefined {
  if (!review?.hostProof && review?.submission.builderProviderType) {
    return { ...review.submission, builderProviderType: review.submission.builderProviderType };
  }
}

function isHostReview(reviewer: RunnerRef, verdict: Verdict, here: string): boolean {
  return (
    reviewer.serverId === null &&
    verdict.reviewer.serverId === null &&
    reviewer.installation === here &&
    verdict.reviewer.installation === here
  );
}

function reviewMatchesPolicy(policy: MergeReviewPolicy, reviewer: RunnerRef, verdict: Verdict) {
  return (
    /^[a-f0-9]{40}$/.test(policy.configCommit) &&
    Boolean(policy.providerType.trim()) &&
    reviewer.role === "reviewer" &&
    reviewer.providerType === policy.providerType &&
    verdict.reviewer.providerType === policy.providerType &&
    verdict.reviewer.agentId === reviewer.agentId &&
    verdict.source === "local-runner"
  );
}

function checkedForeignReview(
  issue: number,
  pull: PullRef,
  evidence: ApprovalEvidence,
  here: string,
) {
  if (!evidence.foreignReview) return null;
  const foreign = assessForeignReview(issue, pull, evidence, here);
  if ("refused" in foreign) return foreign;
  return recordedForeignReviewMatches(evidence, foreign)
    ? foreign
    : { refused: "Record the first exact-head foreign review outcome on this Host." };
}

function evaluateApprovals(
  issue: number,
  pull: PullRef,
  evidence: ApprovalEvidence,
  here: string,
): EvaluatedApproval {
  const { lead, reviewer, verdict } = evidence;
  const approvedHead = evidence.foreignReview ? pull.headSha : reviewedHead(issue, pull, evidence);
  if (!verdict || !verdict.approved || verdict.sha !== approvedHead) {
    return { ready: false, waitingOn: "Get reviewer approval for the current head." };
  }
  const localBinding =
    reviewer?.agentId === verdict.reviewer.agentId && verdict.source === "local-runner";
  const foreign = checkedForeignReview(issue, pull, evidence, here);
  if (foreign && "refused" in foreign) return { ready: false, waitingOn: foreign.refused };
  const foreignIndependence = foreign?.independence;
  const independent =
    foreignIndependence ??
    (reviewer &&
      independentReview(issue, approvedHead, lead, reviewer, evidence.reviewAccountSelection));
  if (
    !reviewer ||
    !localBinding ||
    !independent ||
    (evidence.reviewPolicy && !reviewMatchesPolicy(evidence.reviewPolicy, reviewer, verdict))
  ) {
    return {
      ready: false,
      waitingOn:
        "Get an independent local review and record account selection when the Reviewer shares the Builder's account.",
    };
  }
  const acceptance = acceptedByForeman(approvedHead, evidence, here);
  if (!acceptance) {
    return {
      ready: false,
      waitingOn: "Get acceptance for the current commit from a separate Lead session.",
    };
  }
  const pr = { number: pull.number, headSha: pull.headSha, checks: pull.checks };
  return {
    ready: true,
    pr,
    verdict: { ...verdict, reviewer },
    acceptance,
    ...(foreignIndependence ? { foreignIndependence } : {}),
  };
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

function mergeIntent(
  primary: string,
  target: MergeTarget,
  evidence: OpenMergeEvidence,
  current: ApprovedMerge,
): MergeIntent {
  const {
    lead,
    acceptanceSession,
    reviewPolicy,
    foreignReview,
    rebaseProof,
    reviewAccountSelection,
  } = evidence;
  return {
    ...target,
    hostGate: {
      primary,
      trustedHead: current.pr.headSha,
      protectedPathsCheckedHead: current.pr.headSha,
    },
    ...(current.foreignIndependence ? { foreignIndependence: current.foreignIndependence } : {}),
    approval: {
      lead,
      reviewer: current.verdict.reviewer,
      verdict: current.verdict,
      acceptance: current.acceptance,
      acceptanceSession,
      ...(reviewPolicy ? { reviewPolicy } : {}),
      ...(foreignReview ? { foreignReview } : {}),
      ...(rebaseProof ? { rebaseProof } : {}),
      ...(reviewAccountSelection ? { reviewAccountSelection } : {}),
    },
  };
}

function sameApprovedReview(
  requested: Verdict,
  current: Verdict,
  foreign: ForeignMergeReview | undefined,
): boolean {
  if (foreign?.recorded) {
    return reviewerVerdictDigest(requested) === reviewerVerdictDigest(current);
  }
  return requested.sha === current.sha && requested.reviewer.agentId === current.reviewer.agentId;
}

function matchesRecordedHost(intent: MergeIntent, here: string, head: string): boolean {
  const proof = intent.hostGate;
  if (!proof) return !intent.approval.foreignReview;
  return (
    proof.primary === here && proof.trustedHead === head && proof.protectedPathsCheckedHead === head
  );
}

export function createMergeGate(deps: MergeGateDeps): RecoverableMergeGate {
  const laneUnavailable = "Wait until this installation holds the merge lane.";
  function hostPolicyRefusal(evidence: ApprovalEvidence): string | null {
    if (!deps.requirePinnedReviewerPolicy && !deps.requireIndependentHostProof) return null;
    if (evidence.reviewPolicy?.placement !== "host")
      return "Verify the owner selected Host placement and a pinned Reviewer provider.";
    const { reviewer, verdict, acceptanceSession } = evidence;
    if (reviewer && verdict && !isHostReview(reviewer, verdict, deps.here))
      return "Use the Reviewer assigned to this Host.";
    if (
      deps.requireIndependentHostProof &&
      acceptanceSession &&
      (acceptanceSession.serverId !== null || acceptanceSession.installation !== deps.here)
    )
      return "Use the separate acceptance session assigned to this Host.";
    return null;
  }

  function evaluateBoundOpen(issue: number, evidence: OpenMergeEvidence): EvaluatedApproval {
    if (
      deps.requireIndependentHostProof &&
      evidence.lease &&
      evidence.lease.installation !== deps.here &&
      !evidence.foreignReview?.hostProof
    ) {
      return {
        ready: false,
        waitingOn: "Verify the foreign build and its approved plan on the primary Host.",
      };
    }
    const refusal = hostPolicyRefusal(evidence);
    return refusal
      ? { ready: false, waitingOn: refusal }
      : evaluateOpen(issue, deps.here, evidence);
  }

  async function submit(target: MergeTarget, review?: ForeignMergeReview) {
    if (review?.hostProof) return deps.submit(target, undefined, review.hostProof);
    if (review) return deps.submit(target, signedSubmission(review));
    return deps.submit(target);
  }

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
    if (!intent || !sameTarget) return inconsistent();
    if (
      hostPolicyRefusal(intent.approval) ||
      !matchesRecordedHost(intent, deps.here, target.headSha)
    )
      return inconsistent();
    const approval = evaluateApprovals(target.issue, evidence.pull, intent.approval, deps.here);
    if (!approval.ready || approval.foreignIndependence !== intent.foreignIndependence)
      return inconsistent();
    if (!(await deps.fenceMerge(epoch))) return { refused: laneUnavailable };
    const foreign = intent.approval.foreignReview;
    if (deps.requireIndependentHostProof && foreign && !foreign.hostProof) return inconsistent();
    const foreignSubmission = signedSubmission(foreign);
    const result = await deps.complete({
      ...target,
      mergeSha: evidence.mergeSha,
      epoch,
      ...(foreignSubmission ? { foreignSubmission } : {}),
      ...(foreign?.hostProof ? { hostProof: foreign.hostProof } : {}),
    });
    if (!result.done) return { refused: result.reason };
    return { mergeSha: evidence.mergeSha };
  }

  return {
    async evaluate(issue) {
      const epoch = await deps.currentMergeEpoch();
      if (epoch === null) return { ready: false, waitingOn: laneUnavailable };
      const evidence = await deps.read(issue);
      if (evidence.kind !== "open") return { ready: false, waitingOn: waitingOn(evidence) };
      return evaluateBoundOpen(issue, evidence);
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
      const current = evaluateBoundOpen(issue, evidence);
      if (!current.ready) return { refused: current.waitingOn };
      const sameReview = sameApprovedReview(verdict, current.verdict, evidence.foreignReview);
      const sameAcceptance =
        acceptance.sha === current.acceptance.sha &&
        acceptance.session === current.acceptance.session &&
        acceptance.at === current.acceptance.at;
      if (!sameReview || !sameAcceptance) {
        return { refused: "The approval evidence changed. Reconcile it again." };
      }
      if (!(await deps.fenceMerge(epoch))) return { refused: laneUnavailable };
      const recorded = await deps.recordIntent(
        mergeIntent(deps.here, target, evidence, current),
        epoch,
      );
      if (!recorded.done) return { refused: recorded.reason };
      if (!(await deps.fenceMerge(epoch))) return { refused: laneUnavailable };
      const result = await submit(target, evidence.foreignReview);
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
