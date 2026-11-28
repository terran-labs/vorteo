/**
 * Lean Factory: the frozen contracts every workstream builds against. Types and interfaces only;
 * no behaviour lives here. Change this file only by agreement with every workstream owner (W1
 * coordinates), and only additively once other workstreams have built on it.
 *
 * Ownership of the implementations, by section of the architecture:
 * - W1: LeanStateStore, LeanModePort, deriveStages, plan, the reconcile loop (1.1 to 1.3).
 * - W2: RunnerPort, AccountTable, CapacityPort (1.4 to 1.6).
 * - W3: LeasePort, LanePort, LaneLeasePort, PresencePort, ConfigReader (1.7, 1.8, 1.14, 1.17).
 * - W4: MergeGate, DeliveryPort (1.9, 1.10).
 * - W5: Watchdog, Router, ActivityLog, OperationalSessions, AcceptancePort, IntentStore,
 *   PushAlerts (1.11, 1.12, 1.18).
 * - W6: the CLI and app, against `plugins/factory/shared/lean.ts` only.
 * - W7: ReleaseRecipeReader, BetaTrigger, ReleasesPort (1.15).
 *
 * Global rules every implementation keeps:
 * - GitHub is the source of truth for issues, branches, pull requests, checks, leases, lanes
 *   and presence. The ledger holds only what GitHub cannot: runner identity, deadlines, parks,
 *   queued events, escalations, intent and rules, delivery and release records.
 * - Only the daemon writes the ledger. Agents change it through RPCs, which go through
 *   `LeanStateStore.mutate`.
 * - Time comparisons across machines never use another machine's clock. Expiry of anything
 *   written by another installation is measured from when this reader first saw it unchanged.
 * - Every refusal and park carries a plain sentence the owner can act on.
 * - Held pending owner decisions (do not build behaviour that depends on them yet):
 *   decision 1 (where reviews of a secondary's pull request run: `Verdict.source`),
 *   decision 3 (heavy placement granularity beyond per issue: `CapacityPort`),
 *   decision 7 (lanes that follow availability: until answered, `LaneLeasePort` lets only the
 *   first effective holder acquire; intake stays pinned until the ledger is portable).
 */

import type { DeliveryRun } from "./delivery/executor.js";
import type {
  FactoryActivityEntry,
  FactoryConfigV1,
  FactoryEffectiveConfig,
  FactoryReleaseEvent,
  ReleaseRecipeV1,
} from "@getpaseo/server/factory-lean";

// ---------------------------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------------------------

export type FactoryMode = "crew" | "lean";
/** `<serverId>/<projectId>`: non-secret, as `vorteo factory project show` prints it. */
export type Installation = string;
/** Linear lanes that exactly one installation holds at a time (1.8). */
export type Lane = "intake" | "merge" | "delivery" | "releaseBuild" | "mechanic";
/**
 * Runners are agents the daemon opens for one job and closes. `foreman-op` is an operational
 * Foreman session (1.12, 1.18); `mechanic` is a Mechanic session opened on an event.
 */
export type RunnerRole = "lead" | "reviewer" | "delivery" | "foreman-op" | "mechanic";

/** Bumped on any change a peer must understand; carried by leases and presence. */
export const LEAN_PROTOCOL_MAJOR = 1;

// ---------------------------------------------------------------------------------------------
// Issue stages (1.3). Derived on every pass from GitHub facts plus the ledger.
// ---------------------------------------------------------------------------------------------

export type IssueStage =
  | { kind: "queued" }
  | { kind: "claimed"; lease: Lease }
  | { kind: "planning"; lease: Lease; lead: RunnerRef }
  /** The lead posted its plan; waiting for plan acceptance (when on) and the overlap check. */
  | { kind: "plan-ready"; lease: Lease; lead: RunnerRef; files: string[] }
  | { kind: "deferred"; lease: Lease; lead: RunnerRef; overlapsIssue: number }
  | { kind: "building"; lease: Lease; lead: RunnerRef }
  | { kind: "checks"; lease: Lease; pr: PullRef }
  | { kind: "review"; lease: Lease; pr: PullRef; reviewer: RunnerRef | null }
  /** A failing check or the reviewer's findings, sent to the lead. */
  | { kind: "repair"; lease: Lease; pr: PullRef; findings: string; lead: RunnerRef | null }
  /** Reviewed and green; an acceptance session judges it against the owner's intent. */
  | { kind: "accepting"; lease: Lease; pr: PullRef; verdict: Verdict; session: RunnerRef | null }
  /** Acceptance sent numbered improvements back; the new head goes round again. */
  | {
      kind: "sent-back";
      lease: Lease;
      pr: PullRef;
      improvements: string[];
      round: number;
      lead: RunnerRef | null;
    }
  /** Checks, verdict and acceptance all on `pr.headSha`; the merge lane may merge it. */
  | { kind: "approved"; lease: Lease; pr: PullRef; verdict: Verdict; acceptance: Acceptance }
  | { kind: "merged"; mergeSha: string }
  | { kind: "parked"; reason: ParkReason; until: string | null }
  /** Waits for the owner; `reason` is the sentence shown to them. */
  | { kind: "blocked"; reason: string }
  /** Another installation holds the issue's lease. */
  | { kind: "foreign"; installation: Installation };

export type IssueStageKind = IssueStage["kind"];

export type ParkReason =
  | { kind: "quota"; providerType: string; resetsAt: string | null }
  | { kind: "capacity" }
  /** The intake trust gate's refusal, verbatim (PR #698). */
  | { kind: "untrusted"; reason: string }
  | { kind: "dev-unavailable"; reason: string }
  /** The project's lane holder for this stage is not this installation or not answering. */
  | { kind: "lane"; lane: Lane; reason: string };

// ---------------------------------------------------------------------------------------------
// Shared records
// ---------------------------------------------------------------------------------------------

/** An issue lease (1.7): the claim branch plus a daemon-written, renewed lease comment. */
export interface Lease {
  issue: number;
  /** `factory/issue-<n>`. */
  branch: string;
  installation: Installation;
  /** As written by the holder; informational only (never compared across clocks). */
  renewedAt: string;
  expiresAt: string;
  /** When this reader first saw the lease comment in its current form (reader clock). */
  seenUnchangedSince: string;
  protocol: number;
  released: boolean;
}

/** A runner as the daemon recorded it when it opened it. Labels are display only. */
export interface RunnerRef {
  /** Owning Factory installation; the execution connection can be a different daemon. */
  installation?: Installation;
  agentId: string;
  role: RunnerRole;
  /** Null for this daemon; otherwise the connected host it runs on (Dev). */
  serverId: string | null;
  /** This daemon's (or `serverId`'s) local account id the runner launched on; null for the configured default. */
  account: string | null;
  /**
   * The installation account definition behind `account`. One account has different local ids
   * on Host and Dev, so parks and independence checks use this id. Null when unknown.
   */
  accountDefinition: string | null;
  providerType: string | null;
  openedAt: string;
  /** 1 for the first runner of this role on this issue; +1 for each reopening. */
  attempt: number;
}

export interface PullRef {
  number: number;
  headSha: string;
  checks: "pending" | "passing" | "failing";
}

/** A reviewer's verdict, bound to the commit it reviewed. */
export interface Verdict {
  sha: string;
  approved: boolean;
  reviewer: RunnerRef;
  /** Findings text for a rejection, verbatim from the reviewer's reply. */
  findings: string | null;
  /**
   * Where it was read: this daemon's own reviewer runner (its last message), or another
   * installation's daemon-written verdict marker. Held: decision 1 may remove the marker path.
   */
  source: "local-runner" | { installation: Installation; commentId: number };
}

/** The Foreman role's acceptance of one exact commit against the owner's intent (1.18). */
export interface Acceptance {
  sha: string;
  outcome: "accepted" | "sent-back" | "escalated";
  /** Numbered improvements, verbatim, when sent back. */
  improvements: string[];
  /** The operational session's agent id. */
  session: string;
  source: "local-session" | { installation: Installation; commentId: number };
  at: string;
}

/** Anything a component needs the Foreman role or the Mechanic to hear about (1.12). */
export type FactoryEvent =
  | { kind: "reviewed-green"; issue: number; sha: string }
  | { kind: "plan-posted"; issue: number; files: string[] }
  | { kind: "overlap-stuck"; issue: number; with: number[]; since: string }
  | { kind: "scope-exceeded"; issue: number; files: string[] }
  | {
      kind: "stall";
      issue: number | null;
      stage: IssueStageKind | "delivery-lock" | "escalation" | "loop";
      waitingSince: string;
      deadline: string;
    }
  | { kind: "no-account"; providerType: string; resetsAt: string | null }
  | { kind: "runner-question"; issue: number; text: string; commentUrl: string }
  | { kind: "delivery-failed"; jobId: string; summary: string }
  | { kind: "repair-loop"; issue: number; attempts: number }
  | { kind: "sampler"; metric: string; value: number; threshold: number }
  | { kind: "version-skew"; installation: Installation; protocol: number }
  | { kind: "lane-unanswered"; lane: Lane; holder: Installation | null; since: string };

export type EventClass = "mechanical" | "judgment" | "owner" | "mechanic";

export interface RoutedEvent {
  id: string;
  at: string;
  class: EventClass;
  event: FactoryEvent;
  issue: number | null;
}

// ---------------------------------------------------------------------------------------------
// Ledger (1.1): `$PASEO_HOME/factory/lean/<projectId>.json`, written atomically.
// ---------------------------------------------------------------------------------------------

export interface OwnerApproval {
  actionId: string;
  eventId: string;
  version: string;
  words: string;
  at: string;
}

export interface DeliveryExecutorHolder {
  kind: "executor";
  installation: Installation;
}

export interface DeliveryJob {
  id: string;
  kind: "deliver" | "cut-beta" | "promote" | "rollback";
  /** Exact commits the runner may act on, oldest first. */
  commits: string[];
  /** For promote and rollback: the release event acted on. */
  releaseEventId: string | null;
  /** The owner action that authorized promote or rollback. */
  ownerAction: string | null;
  approval?: OwnerApproval | null;
}

export interface DeliveryLock {
  holder: RunnerRef | DeliveryExecutorHolder;
  job: DeliveryJob;
  /** The delivery lane lease epoch the lock was taken under; recorded on every receipt. */
  laneEpoch: number;
  takenAt: string;
  expiresAt: string;
}

export interface DeliveryReceipt {
  jobId: string;
  kind: DeliveryJob["kind"];
  commits: string[];
  target: string;
  verifiedAt: string;
  /** What was checked against the target, not the command's exit code. */
  verification: string;
  outcome: "delivered" | "failed";
  laneEpoch: number;
  notesUrl: string | null;
}

export interface Escalation {
  id: string;
  /** "escalation" from an operational session; "intent-question" from `factory.lean.ask`. */
  kind: "escalation" | "intent-question";
  question: string;
  why: string;
  options: string[];
  recommended: string;
  blocksIssues: number[];
  eventIds: string[];
  openedAt: string;
  answeredAt: string | null;
  answer: string | null;
}

/** What the conversational Foreman recorded about an issue's intent (1.18). */
export interface IntentRecord {
  issue: number;
  /** The owner's words, quoted with their date. */
  quotes: string[];
  notes: string;
  updatedAt: string;
}

export interface StandingRule {
  id: string;
  text: string;
  /** "all", "label:<name>" or "path:<glob>". */
  scope: string;
  ownerQuote: string;
  addedAt: string;
}

export interface LeanLedger {
  version: 1;
  /** Increases on every mutation; RPC callers pass it back as `expectedRevision`. */
  revision: number;
  runners: Record<
    string,
    RunnerRef & { issue: number | null; closedAt: string | null; closeReason: string | null }
  >;
  /** Leases this installation holds, by issue number. */
  leases: Record<string, Lease>;
  /** Native Host assignment sealed at Builder creation, before its first edit. */
  hostBuilderAssignments?: Record<
    string,
    {
      issue: number;
      generation: string;
      workspaceId: string;
      headSha: string;
      account: string;
      branch: string;
    }
  >;
  parkedAccounts: Record<string, { providerType: string; until: string; reason: string }>;
  /** Keyed by a stable deadline key, such as `issue:12:review` or `delivery-lock`. */
  deadlines: Record<
    string,
    { since: string; deadline: string; firedAt: string | null; breaches: number }
  >;
  /** Acceptance and send-back history per issue, newest last. */
  acceptances: Record<string, Acceptance[]>;
  /** Event ids already answered by a decision, kept for 7 days to make RPCs idempotent. */
  answeredEvents: Record<string, string>;
  pendingEvents: { routed: RoutedEvent; queuedAt: string; deliveredAt: string | null }[];
  escalations: Escalation[];
  intent: Record<string, IntentRecord>;
  rules: StandingRule[];
  delivery: {
    lock: DeliveryLock | null;
    receipts: DeliveryReceipt[];
    runs?: Record<string, DeliveryRun>;
  };
  releases: FactoryReleaseEvent[];
  /** Owner pre-authorization for the next qualifying beta; null when none. */
  preauthorization: {
    conditions: { minSoakHours: number; requireStableGates: boolean };
    grantedAt: string;
    ownerAction: string;
  } | null;
  /** This machine's settings, never written to the repository. */
  local: { runners: number; heavyQueueLimit: number };
  /** Last completed reconcile pass; read by the watchdog's own timer. */
  loopBeat: string | null;
}

export interface LeanStateStore {
  read(projectId: string): Promise<LeanLedger>;
  /**
   * Serialized per project; increments `revision`. Throws RevisionConflictError when
   * `expectedRevision` is given and differs, so stale agent decisions are refused.
   */
  mutate<T>(
    projectId: string,
    change: (ledger: LeanLedger) => T,
    expectedRevision?: number,
  ): Promise<T>;
}

export class RevisionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `The Factory state changed since revision ${expected} (now ${actual}). Read status again.`,
    );
    this.name = "RevisionConflictError";
  }
}

// ---------------------------------------------------------------------------------------------
// W1: mode, facts, stages and dispatch (1.2, 1.3)
// ---------------------------------------------------------------------------------------------

export interface LeanModePort {
  /** Starts the reconcile loop for a lean project. Idempotent. */
  start(projectId: string): Promise<void>;
  /** Stops it. "pause" and "disable" release this installation's leases after runners push. */
  stop(projectId: string, reason: "disable" | "pause" | "switch"): Promise<void>;
}

/** What `deriveStages` needs from GitHub for one admitted or claimed issue. */
export interface AdmissionFacts {
  number: number;
  title: string;
  labels: string[];
  /** The intake trust verdict for the current text (PR #698). */
  trust: { trusted: true } | { trusted: false; reason: string };
  heavy: boolean;
  priority: boolean;
  createdAt: string;
  /** The lead's latest Resolution plan, when posted. */
  plan: {
    commentId: number;
    files: string[];
    heavy: boolean;
    postedAt: string;
    contentDigest?: string;
  } | null;
  /** Daemon-recorded go for the current plan, if any. */
  go: { at: string; files: string[] } | null;
  /** Unanswered `factory-question` comments from runners, oldest first. */
  questions: { commentId: number; text: string; url: string }[];
  /** Daemon-written send-back comments, newest last. */
  sendBacks: { sha: string; improvements: string[]; commentId: number }[];
}

export interface PullFacts {
  /** The primary verified the foreign pull request at this exact head. */
  foreignReviewHead?: string;
  /** The daemon verified that a Reviewer can inspect this exact head while checks run. */
  reviewEligible?: boolean;
  number: number;
  head: string;
  branch: string;
  sameRepo: boolean;
  files: string[];
  checks: PullRef["checks"];
  mergeable: boolean | null;
  /** Unresolved review threads from trusted accounts. */
  trustedThreadsOpen: number;
  labels: string[];
}

export interface GitHubFacts {
  issues: AdmissionFacts[];
  pulls: PullFacts[];
  /** Every installation's issue leases, parsed from trusted lease comments. */
  leases: Lease[];
  /** Daemon-written verdict and acceptance markers from other installations. */
  verdicts: { issue: number; verdict: Verdict }[];
  acceptances: { issue: number; acceptance: Acceptance }[];
  defaultBranchSha: string;
  readAt: string;
}

export interface DispatchContext {
  here: Installation;
  now: Date;
  /** Lanes this installation holds a live lease for right now. */
  lanesHeld: ReadonlySet<Lane>;
  capacity: CapacitySnapshot;
  config: FactoryConfigV1 | null;
}

export type DispatchAction =
  | { kind: "claim"; issue: number }
  | { kind: "open-runner"; issue: number | null; role: RunnerRole; reason: string; brief: string }
  | { kind: "send-go"; issue: number; lead: RunnerRef; files: string[] }
  | { kind: "send-repair"; issue: number; lead: RunnerRef; findings: string }
  | {
      kind: "deliver-send-back";
      issue: number;
      lead: RunnerRef | null;
      improvements: string[];
      sha: string;
    }
  | { kind: "merge"; issue: number; pr: PullRef; verdict: Verdict; acceptance: Acceptance }
  | { kind: "renew-lease"; issue: number }
  /**
   * `capacity`: at plan-ready a heavy issue on a machine whose heavy queue is over its limit is
   * released so another machine claims it (W1 dispatcher). Only `factory:heavy` affects the
   * claim itself, since the plan does not exist yet when the claim happens.
   */
  | { kind: "release-lease"; issue: number; why: "done" | "capacity" | "takeover" }
  | { kind: "park"; issue: number; reason: ParkReason }
  | { kind: "close-runner"; runner: RunnerRef; reason: string }
  | { kind: "route"; event: FactoryEvent }
  | { kind: "start-delivery"; job: DeliveryJob };

/** Pure. Never reads the network; facts and ledger in, stages out. */
export type DeriveStages = (
  facts: GitHubFacts,
  ledger: LeanLedger,
  here: Installation,
  now: Date,
) => Map<number, IssueStage>;

/**
 * Pure. Actions in a fixed priority: merge, deliver, accept, review, repair, go, open, claim.
 * Idempotent: running it twice on the same inputs plans the same actions, and executing an
 * action already done is a no-op.
 */
export type PlanActions = (
  stages: Map<number, IssueStage>,
  ledger: LeanLedger,
  ctx: DispatchContext,
) => DispatchAction[];

// ---------------------------------------------------------------------------------------------
// W2: runners, accounts, capacity (1.4 to 1.6)
// ---------------------------------------------------------------------------------------------

/**
 * `quota`: the agent manager's structured usage-limit stop (its quota latch and observer),
 * never parsed from error text. `detached`: the daemon restarted and the in-memory status
 * subscription is gone; reattach from the ledger, never treat it as the job being done.
 */
export type RunnerStatus =
  | { kind: "running" }
  | { kind: "idle" }
  | { kind: "error"; detail: string }
  | { kind: "permission"; detail: string }
  | { kind: "quota"; accountDefinition: string | null; resetsAt: string | null }
  | { kind: "detached" };

export interface RunnerOpenInput {
  foreignReview?: import("./review-evidence.js").ForeignReviewOpenEvidence;
  projectId: string;
  issue: number | null;
  role: RunnerRole;
  /** The first prompt: the claim brief plus role-specific facts. */
  brief: string;
  /** Accounts not to use, such as the lead's account for a reviewer. */
  avoidAccounts?: string[];
  /** Where the issue's worktree lives; null lets the runner create it as its charter says. */
  worktree?: { serverId: string | null; path: string } | null;
}

export interface RunnerPort {
  /** Opens one runner, or parks when no account or capacity is available. */
  open(input: RunnerOpenInput): Promise<RunnerRef | { parked: ParkReason }>;
  prompt(runner: RunnerRef, text: string): Promise<"sent" | "busy" | "gone">;
  /**
   * Archives the AGENT only, never its workspace: a workspace archive deletes the worktree.
   * A lead's close is refused until its branch is pushed (local head equals the remote branch).
   */
  close(runner: RunnerRef, why: string): Promise<{ closed: true } | { refused: string }>;
  /**
   * On daemon start: re-subscribe to every open runner in the ledger. Status subscriptions and
   * finish subscriptions are in memory and can be consumed by a "was closed" notice, so the
   * ledger is the only record of what is open.
   */
  reattach(runners: RunnerRef[]): Promise<{ attached: RunnerRef[]; gone: RunnerRef[] }>;
  /** The agent's own last assistant message, read by the daemon; never from a PR comment. */
  lastReply(runner: RunnerRef): Promise<string | null>;
  onStatus(listener: (runner: RunnerRef, status: RunnerStatus) => void): () => void;
}

export interface AccountChoice {
  /** The destination's local account id. */
  account: string | null;
  accountDefinition: string | null;
  providerType: string;
  profileId: string | null;
}

export interface AccountTable {
  choose(input: {
    role: RunnerRole;
    serverId: string | null;
    avoid: string[];
  }): Promise<AccountChoice | { parked: { providerType: string; resetsAt: string | null } }>;
  /**
   * Parks by installation account definition, so a refusal on Dev also parks the Host binding
   * of the same account. Skipped until `until`, or 60 minutes when the reset time is unknown.
   */
  park(
    accountDefinition: string,
    providerType: string,
    until: string | null,
    reason: string,
  ): Promise<void>;
}

export interface CapacitySnapshot {
  runners: { open: number; max: number };
  /**
   * The machine's heavy-job queue runs ONE heavy job at a time (scripts/heavy-job.mjs has one
   * holder per computer). `queueLimit` is how many waiting heavy tickets this machine accepts
   * before it stops claiming heavy issues; more machines, not a higher limit, add parallel heavy
   * capacity. Real parallel slots in the shared ticket protocol are a post-MVP option.
   */
  heavy: { running: boolean; waiting: number; queueLimit: number };
  /** The heavy-job queue's memory guard. */
  memory: { ok: boolean; reason: string | null };
}

export interface CapacityPort {
  snapshot(): Promise<CapacitySnapshot>;
  /**
   * Whether this machine may open a runner now. A heavy issue also needs fewer heavy waiters
   * than slots. Held: decision 3 may add cross-machine offload of one pull request's suites.
   */
  canOpen(
    role: RunnerRole,
    issue: { heavy: boolean } | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

// ---------------------------------------------------------------------------------------------
// W3: leases, lanes, presence, configuration (1.7, 1.8, 1.14, 1.17)
// ---------------------------------------------------------------------------------------------

export type LeaseAcquire =
  | {
      outcome: "claimed" | "held";
      lease: Lease;
      brief: string;
      checkedHeadSha: string | null;
      continueFrom: string | null;
    }
  | { outcome: "foreign"; lease: Lease | null }
  /** Trust gate or owner-only file refusals, with their codes and sentences. */
  | { outcome: "refused"; code: string; reason: string };

export interface LeasePort {
  /** Claims through `claimIssue`, then writes the lease comment. `continueFrom` names an archive branch after a takeover. */
  acquire(issue: number): Promise<LeaseAcquire>;
  renew(issue: number): Promise<Lease>;
  release(
    issue: number,
    why: "pause" | "disable" | "done" | "takeover" | "capacity",
  ): Promise<void>;
  /** Expired by this reader's clock and with no push for the TTL. Decision 2: taken over without asking. */
  expired(leases: Lease[], now: Date): Lease[];
}

export interface LaneHolder {
  lane: Lane;
  /** The configured holder, or the first entry of an ordered list. */
  configured: Installation | null;
  /** The effective ordered holders: the lane's own list, else the project's default order. */
  ordered: Installation[];
  /** A machine-bound lane never moves (an install onto one machine); only `configured` may hold it. */
  pinned: boolean;
  /** Who holds the lane lease now, if anyone. */
  leaseHolder: Installation | null;
  epoch: number | null;
  here: boolean;
  error: string | null;
}

export interface LanePort {
  holder(lane: Lane): Promise<LaneHolder>;
  /** The optional claimers allowlist; true when absent. */
  mayClaim(installation: Installation): Promise<boolean>;
}

/** `refs/factory/lanes/<lane>`; compare-and-swap through non-force ref updates. */
export interface LaneLeasePort {
  acquire(
    lane: Lane,
  ): Promise<{ held: true; epoch: number } | { held: false; holder: Installation | null }>;
  renew(lane: Lane): Promise<{ held: boolean; epoch: number | null }>;
  release(lane: Lane, why: "pause" | "disable" | "handover"): Promise<void>;
  /** Re-reads the ref; true only while it still points at this holder's last write. Call before every lane action. */
  fence(lane: Lane, epoch: number): Promise<boolean>;
}

export interface PresenceRecord {
  v: 1;
  installation: Installation;
  factory: "on" | "paused" | "off";
  mode: FactoryMode;
  daemonVersion: string;
  leanProtocol: number;
  /** Waiting heavy tickets accepted before the machine stops claiming heavy issues. */
  heavyQueueLimit: number;
  runnersMax: number;
  runnersOpen: number;
  seq: number;
}

/** `refs/factory/presence/<serverId>/<projectId>`; no hostnames or owner details, ever. */
export interface PresencePort {
  publish(record: Omit<PresenceRecord, "v" | "seq">): Promise<void>;
  /** Every installation's record with reader-relative freshness. */
  list(
    now: Date,
  ): Promise<
    (PresenceRecord & { seenUnchangedSince: string; freshness: "fresh" | "stale" | "offline" })[]
  >;
}

export interface ConfigReader {
  /** The configuration from the default branch, with the legacy `.github/factory.json` fallback. */
  read(): Promise<{ config: FactoryConfigV1 | null; effective: FactoryEffectiveConfig }>;
}

// ---------------------------------------------------------------------------------------------
// W4: merge gate and delivery (1.9, 1.10)
// ---------------------------------------------------------------------------------------------

export interface MergeGate {
  /**
   * On the merge lane's installation only. Ready requires: trusted issue, same-repo pull
   * request from the claim branch with a live lease, no owner-only file, verdict sha =
   * acceptance sha = head = checkedHeadSha with an accepted outcome, green checks, no
   * factory:blocked and no trusted unresolved threads, mergeable.
   */
  evaluate(
    issue: number,
  ): Promise<
    | { ready: true; pr: PullRef; verdict: Verdict; acceptance: Acceptance }
    | { ready: false; waitingOn: string }
  >;
  /** Pinned to the head (REST `sha` or merge-queue `expectedHeadOid`); fences the merge lane first. */
  merge(
    issue: number,
    pr: PullRef,
    verdict: Verdict,
    acceptance: Acceptance,
  ): Promise<{ mergeSha: string } | { refused: string }>;
}

export interface DeliveryPort {
  /** Takes the lock and opens a delivery runner for the job, on the delivery or releaseBuild lane. */
  start(
    job: DeliveryJob,
  ): Promise<{ started: true; lock: DeliveryLock } | { started: false; reason: string }>;
  /** Called by the `factory.lean.delivery.report` handler; checks the job id against the lock. */
  report(
    receipt: Omit<DeliveryReceipt, "laneEpoch">,
  ): Promise<{ accepted: boolean; reason: string | null }>;
  /** Merged commits on the default branch since the last delivered one. */
  undelivered(): Promise<string[]>;
}

// ---------------------------------------------------------------------------------------------
// W5: watchdog, router, sessions, acceptance, intent, activity, alerts (1.11, 1.12, 1.18)
// ---------------------------------------------------------------------------------------------

export interface Watchdog {
  arm(key: string, deadline: Date): Promise<void>;
  clear(key: string): Promise<void>;
  /** Deadlines due now; `secondBreach` means the deterministic retry already ran once. */
  due(now: Date): Promise<{ key: string; since: string; secondBreach: boolean }[]>;
}

export interface Router {
  /** Classifies and enqueues; mechanical events are acted on by the caller and logged. */
  route(event: FactoryEvent): Promise<RoutedEvent>;
}

export interface ActivityLog {
  /** `$PASEO_HOME/factory/lean/<projectId>-activity.jsonl`, append-only, rotated at 10,000 lines. */
  append(entry: Omit<FactoryActivityEntry, "id" | "at">): Promise<FactoryActivityEntry>;
  list(input: {
    before?: string;
    limit?: number;
  }): Promise<{ entries: FactoryActivityEntry[]; nextBefore: string | null }>;
}

/** Operational Lead sessions run independently per issue. */
export interface OperationalSessions {
  open(input: {
    purpose: "judgment" | "acceptance" | "plan-acceptance";
    issue: number | null;
    events: RoutedEvent[];
  }): Promise<RunnerRef | { queued: true }>;
}

export interface AcceptanceBrief {
  issue: number;
  /** The trust brief: approved text with acceptance criteria. */
  approvedText: string;
  intent: IntentRecord | null;
  rules: StandingRule[];
  plan: string | null;
  diffSummary: { files: string[]; outsidePlan: string[]; additions: number; deletions: number };
  verdict: Verdict | null;
  evidence: {
    kind: "test-output" | "check" | "screenshot" | "preview";
    label: string;
    url: string | null;
    text: string | null;
  }[];
  inFlight: {
    issue: number;
    stage: IssueStageKind;
    files: string[];
    installation: Installation | null;
  }[];
  recentMerges: { issue: number | null; pr: number; title: string; files: string[]; at: string }[];
  sendBackRound: number;
}

export interface AcceptancePort {
  brief(issue: number, sha: string): Promise<AcceptanceBrief>;
  /** Refused for any commit but the head. */
  accept(
    issue: number,
    sha: string,
    session: RunnerRef,
  ): Promise<{ accepted: boolean } | { refused: string }>;
  /** Posts the improvements verbatim, delivers them unchanged to the lead, escalates past the bound. */
  sendBack(
    issue: number,
    sha: string,
    improvements: string[],
    session: RunnerRef,
  ): Promise<{ round: number; escalated: boolean } | { refused: string }>;
}

export interface IntentStore {
  setIntent(record: Omit<IntentRecord, "updatedAt">): Promise<void>;
  addRule(rule: Omit<StandingRule, "id" | "addedAt">): Promise<StandingRule>;
  removeRule(id: string): Promise<boolean>;
  /** Rules whose scope matches the issue's labels or the changed paths. */
  rulesFor(input: { labels: string[]; paths: string[] }): Promise<StandingRule[]>;
}

/** Model-free owner alerts through the push service. */
export interface PushAlerts {
  alert(input: {
    title: string;
    body: string;
    dedupeKey: string;
    minIntervalMinutes: number;
  }): Promise<"sent" | "deduped" | "unavailable">;
}

// ---------------------------------------------------------------------------------------------
// W7: release pipeline (1.15)
// ---------------------------------------------------------------------------------------------

export interface ReleaseRecipeReader {
  read(): Promise<{ recipe: ReleaseRecipeV1 | null; error: string | null }>;
}

export interface BetaTrigger {
  /** On the releaseBuild lane; never fires while a delivery is in flight or the last beta failed. */
  evaluate(input: {
    delivered: DeliveryReceipt[];
    lastBeta: FactoryReleaseEvent | null;
    candidates: PullRef[];
    now: Date;
  }):
    | { fire: false; reason: string }
    | { fire: true; commit: string; score: number; reason: string };
}

export interface ReleasesPort {
  list(): Promise<{ production: FactoryReleaseEvent | null; events: FactoryReleaseEvent[] }>;
  /** Owner-only; a beta newer than production. Queues a promote delivery job. */
  promote(input: {
    eventId: string;
    expectedProduction: string | null;
    ownerAction: string;
  }): Promise<{ jobId: string } | { refused: string }>;
  /** Owner-only; an accepted release older than production. Recorded as a new rollback event. */
  rollback(input: {
    targetEventId: string;
    expectedProduction: string;
    ownerAction: string;
  }): Promise<{ jobId: string } | { refused: string }>;
  record(event: FactoryReleaseEvent): Promise<void>;
}
