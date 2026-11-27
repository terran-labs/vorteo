import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { claimMarker, FactoryGitHubError } from "../project/claims.js";
import type { ClaimState } from "../project/state.js";
import { issueBrief, issueTrust, readIssueFacts, readTrustedAccounts } from "../project/trust.js";
import type { ReviewAccountSelection } from "./accounts.js";
import { plan } from "./dispatcher.js";
import { createPrimaryGateRuntime, type PrimaryGateRuntimeOptions } from "./gate-runtime.js";
import { createLeanGitHub, type LeanGitHubFacts, type LeanGitHubOptions } from "./github.js";
import { deriveStages, type IssueLedger } from "./issue-state.js";
import { createMergeGate, type MergeEvidence, type MergeIntent } from "./merge-gate.js";
import { createMergeIntentStore } from "./merge-intent.js";
import type { LeanProjectRuntime } from "./mode.js";
import { createOperationRuntime, type OperationRuntimeInput } from "./operation-runtime.js";
import {
  isSecurityReviewApproved,
  proveCleanRebase,
  readSecurityReviewEvidence,
  type ReviewGitObjects,
  type SecurityReviewBinding,
  type SecurityReviewEvidence,
} from "./review-evidence.js";
import { createLocalRunnerRuntime, type LocalRunnerDependencies } from "./runner-adapters.js";
import {
  createRunnerWorkspaceResolver,
  type RunnerWorkspaceDependencies,
} from "./runner-workspaces.js";
import { runnerStatusFromAgent } from "./runners.js";
import { createLeanReconciler } from "./service.js";
import { watchdogMinutes } from "./watchdog.js";
import type {
  AdmissionFacts,
  DeliveryPort,
  DispatchAction,
  DispatchContext,
  FactoryEvent,
  IssueStage,
  Lane,
  LeanStateStore,
  Lease,
  ParkReason,
  PullFacts,
  RunnerOpenInput,
  RunnerPort,
  RunnerRef,
  RunnerStatus,
  Verdict,
} from "./types.js";

type GitHubOptions = Pick<
  LeanGitHubOptions,
  | "github"
  | "repository"
  | "here"
  | "leaseTtlMs"
  | "releaseRecipeFiles"
  | "extraChecks"
  | "requiredChecks"
>;
type RunnerServices = Omit<
  LocalRunnerDependencies,
  | "projectId"
  | "installation"
  | "repository"
  | "github"
  | "state"
  | "now"
  | "resolveWorkspace"
  | "workspaces"
>;
type WorkspaceServices = Pick<
  RunnerWorkspaceDependencies,
  "projects" | "workspaces" | "onWorkspaceChanged"
>;
type PlanPosted = Extract<FactoryEvent, { kind: "plan-posted" }>;
type OperationalServices = Pick<OperationRuntimeInput, "ownerThread" | "questions" | "push">;
type OperationActions = Omit<
  OperationRuntimeInput["actions"],
  "postSendBack" | "sendBackToBuilder"
>;

export interface SecurityReviewJob {
  /** Stable daemon key. A lost launch response must return the same dedicated runner on retry. */
  key: string;
  projectId: string;
  repository: string;
  issue: number;
  headSha: string;
  sensitivePaths: readonly string[];
  builder: RunnerRef;
  primaryReviewer: RunnerRef;
  prompt: string;
}

export interface SecurityReviewPort {
  /** Use a clean, read-only Claude checkout with a durable security-purpose launch binding. */
  open(job: SecurityReviewJob): Promise<SecurityReviewBinding | null>;
  /** Read only this bound agent's own final assistant reply when its turn finishes. */
  result(
    binding: SecurityReviewBinding,
  ): Promise<{ kind: "waiting" | "gone" } | { kind: "finished"; reply: string }>;
  close(binding: SecurityReviewBinding): Promise<void>;
}

export interface LeanRuntimeOptions extends GitHubOptions {
  projectId: string;
  /** The admitted issue assigned to this rollout of the runtime. */
  issue: number;
  paseoHome: string;
  state: LeanStateStore;
  now(): Date;
  /** A fresh local authority read. This must not wait on a provider or GitHub request. */
  executionMode(): Promise<LeanExecutionMode>;
  runner: RunnerServices;
  workspace: WorkspaceServices;
  operations: OperationalServices;
  operationActions: OperationActions;
  /** The single primary controls these epochs. No fallback lane holder is assumed. */
  laneEpoch(lane: Lane): Promise<number | null>;
  fenceLane(lane: Lane, epoch: number): Promise<boolean>;
  context(): Promise<Pick<DispatchContext, "capacity" | "config">>;
  /** Enqueue using a persistent dedupe key and wait for admission to the verified recipient. */
  enqueue(runner: RunnerRef, text: string, key: string): Promise<boolean>;
  primaryGates?: Pick<PrimaryGateRuntimeOptions, "primary" | "execution">;
  securityReview?: SecurityReviewPort;
  /** A verified daemon Git object database populated from the exact repository refs. */
  reviewObjects?(input: {
    issue: number;
    baseSha: string;
    headSha: string;
  }): Promise<ReviewGitObjects | null>;
  /** Read the project policy from the trusted default branch. Absent means independent accounts. */
  allowSameAccount?(): Promise<boolean>;
  mergeMethod?: "MERGE" | "SQUASH";
  delivery?: DeliveryPort;
}

export type LeanExecutionMode = "live" | "dry-run" | "review-rehearsal" | "fenced";

function executing(mode: LeanExecutionMode): boolean {
  return mode === "live" || mode === "review-rehearsal";
}

function guardedOperations(options: LeanProjectOptions): OperationalServices {
  const { questions, push } = options.operations;
  return {
    ...options.operations,
    questions: {
      readQuestions: (agentId) => questions.readQuestions(agentId),
      async mutateQuestions(agentId, mutation) {
        if (!executing(await options.executionMode()))
          throw new Error("Factory execution is fenced.");
        return questions.mutateQuestions(agentId, mutation);
      },
    },
    push: push
      ? {
          async send(payload) {
            if (!executing(await options.executionMode()))
              throw new Error("Factory execution is fenced.");
            await push.send(payload);
          },
        }
      : undefined,
  };
}

function executionState(options: LeanProjectOptions): LeanStateStore {
  return {
    read: (projectId) => options.state.read(projectId),
    async mutate(projectId, change, revision) {
      if (!executing(await options.executionMode()))
        throw new Error("Factory execution is fenced.");
      return options.state.mutate(projectId, change, revision);
    },
  };
}

type PlanRecord = NonNullable<AdmissionFacts["plan"]>;
type RunnerRecord = IssueLedger["runners"][string] & {
  reviewAccountSelection?: ReviewAccountSelection;
};
type NonMergeAction = Exclude<DispatchAction, { kind: "merge" }>;
type OpenEvidence = Extract<MergeEvidence, { kind: "open" }>;

interface RuntimeLedger extends IssueLedger {
  runtimeClaims?: Record<string, ClaimState>;
  runtimeGo?: Record<string, { plan: PlanRecord; at: string }>;
  runtimePlanApproval?: Record<string, PlanRecord>;
  runtimeRepairs?: Record<string, true>;
  runtimeReviewBases?: Record<string, { pullNumber: number; baseSha: string }>;
  runtimeMerges?: Record<string, { head: string; mergeSha: string; settled: boolean }>;
  runtimeParks?: Record<string, { stageKey: string; reason: ParkReason }>;
  runtimeSecurityReviews?: Record<string, SecurityJobRecord>;
  mergeIntents?: Record<string, MergeIntent>;
}

interface SecurityJobRecord {
  key: string;
  binding: SecurityReviewBinding;
  evidence: SecurityReviewEvidence | null;
  closed: boolean;
}

type SecuritySubject = Pick<
  SecurityReviewJob,
  "key" | "headSha" | "sensitivePaths" | "builder" | "primaryReviewer"
>;

interface VerifiedHostedChecks {
  hosted: "passing" | "absent";
  configCommit: string;
}

const fullHead = z.string().regex(/^[a-f0-9]{40}$/);
const lanes: Lane[] = ["intake", "merge", "delivery", "releaseBuild", "mechanic"];
const minute = 60_000;
const loopDeadlineKey = "watchdog:loop";
const waitStages = z.enum([
  "queued",
  "claimed",
  "planning",
  "plan-ready",
  "deferred",
  "building",
  "checks",
  "review",
  "repair",
  "accepting",
  "sent-back",
  "approved",
  "merged",
  "parked",
  "blocked",
]);
type WaitStage = z.infer<typeof waitStages>;
const stageMinutes: Record<WaitStage, number> = {
  ...watchdogMinutes,
  parked: 45,
  blocked: watchdogMinutes.escalation,
};

function waitPrefix(issue: number): string {
  return `runtime-wait:${issue}:`;
}

function waitKey(issue: number, stage: WaitStage, ...generation: unknown[]): string {
  return `${waitPrefix(issue)}${stage}:${key(...generation)}`;
}

function describeIssueWait(deadline: string): { issue: number; stage: WaitStage } | null {
  const match = /^runtime-wait:(\d+):([^:]+):[a-f0-9]{64}$/.exec(deadline);
  if (!match) return null;
  const stage = waitStages.safeParse(match[2]);
  return stage.success ? { issue: Number(match[1]), stage: stage.data } : null;
}

function stageWait(
  issue: number,
  stage: IssueStage | undefined,
  admission: AdmissionFacts | undefined,
) {
  if (!stage || stage.kind === "foreign") return null;
  const runners = [
    "lead" in stage ? stage.lead?.agentId : null,
    "reviewer" in stage ? stage.reviewer?.agentId : null,
    "session" in stage ? stage.session?.agentId : null,
  ];
  const planId = admission?.plan ? [admission.plan.commentId, admission.plan.postedAt] : null;
  let head = "mergeSha" in stage ? stage.mergeSha : null;
  if ("pr" in stage) head = stage.pr.headSha;
  const generation = [
    head,
    runners,
    planId,
    "overlapsIssue" in stage ? stage.overlapsIssue : null,
    "reason" in stage ? stage.reason : null,
  ];
  return {
    id: waitKey(issue, stage.kind, ...generation),
    duration: stageMinutes[stage.kind] * minute,
  };
}

function runnerWait(issue: number, runner: RunnerRef, status: RunnerStatus | undefined) {
  if (status?.kind === "quota") {
    return {
      id: waitKey(issue, "parked", runner.agentId, "quota", status.resetsAt),
      duration: 10 * minute,
    };
  }
  if (status?.kind === "detached" || status?.kind === "error") {
    return { id: waitKey(issue, "parked", runner.agentId, status.kind), duration: 5 * minute };
  }
  return null;
}

/** The timer arms the heartbeat even if provider or GitHub reads are still in progress. */
async function syncProjectWaits(
  state: LeanStateStore,
  projectId: string,
  now: () => Date,
): Promise<void> {
  const previous = await state.read(projectId);
  const unanswered = new Set(
    previous.escalations
      .filter((entry) => entry.answeredAt === null)
      .map((entry) => `escalation:${entry.id}`),
  );
  const overdueEscalations = Object.keys(previous.deadlines).some(
    (name) => name.startsWith("escalation:") && !unanswered.has(name),
  );
  const missingEscalation = [...unanswered].some((name) => !previous.deadlines[name]);
  if (
    previous.loopBeat &&
    previous.deadlines[loopDeadlineKey]?.since === previous.loopBeat &&
    !overdueEscalations &&
    !missingEscalation
  )
    return;
  await state.mutate(projectId, (data) => {
    const at = now();
    const beat = (data.loopBeat ??= at.toISOString());
    if (data.deadlines[loopDeadlineKey]?.since !== beat) {
      data.deadlines[loopDeadlineKey] = {
        since: beat,
        deadline: new Date(Date.parse(beat) + watchdogMinutes.loop * minute).toISOString(),
        firedAt: null,
        breaches: 1,
      };
    }
    const open = new Set<string>();
    for (const entry of data.escalations) {
      if (entry.answeredAt !== null) continue;
      const name = `escalation:${entry.id}`;
      open.add(name);
      data.deadlines[name] ??= {
        since: entry.openedAt,
        deadline: new Date(
          Date.parse(entry.openedAt) + watchdogMinutes.escalation * minute,
        ).toISOString(),
        firedAt: null,
        breaches: 0,
      };
    }
    for (const name of Object.keys(data.deadlines)) {
      if (name.startsWith("escalation:") && !open.has(name)) delete data.deadlines[name];
    }
  });
}

function reviewReply(head: string, reply: string, reviewer: RunnerRef): Verdict | null {
  const [header, ...lines] = reply.trim().split(/\r?\n/);
  const approved = header === `APPROVE ${head}`;
  const findings = lines.join("\n").trim();
  const rejected = header === `Review ${head}` && /^\d+\.\s+\S/m.test(findings);
  if (!approved && !rejected) return null;
  return {
    sha: head,
    reviewer,
    approved,
    findings: approved ? null : findings,
    source: "local-runner",
  };
}

function key(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  return isDeepStrictEqual([...left].sort(), [...right].sort());
}

export function createLeanRuntime(options: LeanRuntimeOptions, shared?: LeanOperationGroup) {
  const { projectId, issue, here, github, repository, now } = options;
  const state = executionState(options);
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error("Factory needs a valid assigned issue.");
  const branch = `factory/issue-${issue}`;
  const root = `repos/${repository}`;
  const statuses = new Map<string, RunnerStatus>();
  const attemptedRunnerWaits = new Set<string>();
  const requestedRetries = new Set<string>();
  const quotaResetAttempts = new Set<string>();
  const listeners = new Set<() => void>();
  const wake = () => listeners.forEach((listener) => listener());
  const ledger = (): Promise<RuntimeLedger> => state.read(projectId);
  const live = async () => !stopped && (await options.executionMode()) === "live";
  const active = async () => !stopped && executing(await options.executionMode());
  const fenceMerge = async (epoch: number) => (await live()) && options.fenceLane("merge", epoch);
  const currentMergeEpoch = async () => ((await live()) ? options.laneEpoch("merge") : null);
  const intent = createMergeIntentStore(state, projectId, fenceMerge);
  let stopped = false;

  async function holds(lane: Lane): Promise<boolean> {
    const mode = await options.executionMode();
    if (stopped || !executing(mode)) return false;
    if (
      mode === "review-rehearsal" &&
      (lane === "merge" || lane === "delivery" || lane === "releaseBuild")
    )
      return false;
    const epoch = await options.laneEpoch(lane);
    return epoch !== null && (await options.fenceLane(lane, epoch));
  }

  async function context(): Promise<DispatchContext> {
    const data = await options.context();
    const held = await Promise.all(lanes.map(async (lane) => ((await holds(lane)) ? lane : null)));
    return { ...data, here, now: now(), lanesHeld: new Set(held.filter((lane) => lane !== null)) };
  }

  function requireIssue(number: number): void {
    if (number !== issue)
      throw new Error("The operation doesn't belong to the assigned Factory issue.");
  }

  async function get<T>(route: string, schema: z.ZodType<T>): Promise<T> {
    const response = await github.rest("GET", route);
    if (response.status !== 200)
      throw new FactoryGitHubError("GitHub refused the Factory runtime read.");
    return schema.parse(response.body);
  }

  function savedRunner(
    data: RuntimeLedger,
    agentId: string,
    role: RunnerRef["role"],
  ): RunnerRecord | null {
    const candidate: RunnerRecord | undefined = data.runners[agentId];
    if (candidate?.issue !== issue || candidate.role !== role || candidate.serverId !== null)
      return null;
    return candidate;
  }

  function builder(data: RuntimeLedger): RunnerRecord | null {
    const entries = Object.values(data.runners).filter(
      (entry) =>
        entry.issue === issue &&
        entry.role === "lead" &&
        entry.serverId === null &&
        entry.closedAt === null,
    );
    return entries.sort((a, b) => b.attempt - a.attempt)[0] ?? null;
  }

  async function fromReviewer(data: RuntimeLedger, head: string) {
    const verdict = data.localVerdicts?.[issue];
    const reviewer = verdict ? savedRunner(data, verdict.reviewer.agentId, "reviewer") : null;
    const provenance = reviewer?.reviewAccountSelection;
    const bound =
      provenance?.issue === issue &&
      provenance.headSha === head &&
      provenance.reviewerAgentId === reviewer?.agentId;
    const accountAllowed =
      provenance?.mode !== "same-account" || (await options.allowSameAccount?.()) === true;
    const review = verdict?.sha === head && bound && accountAllowed ? verdict : null;
    const lead = provenance ? savedRunner(data, provenance.builderAgentId, "lead") : null;
    return {
      lead,
      reviewer,
      verdict: review,
      ...(bound ? { reviewAccountSelection: provenance } : {}),
    };
  }

  async function exactApproval(data: RuntimeLedger, head: string) {
    const last = data.acceptances[issue]?.at(-1);
    const acceptance = last?.sha === head ? last : null;
    const acceptanceSession = acceptance
      ? savedRunner(data, acceptance.session, "foreman-op")
      : null;
    return {
      ...(await fromReviewer(data, head)),
      acceptance,
      acceptanceSession,
    };
  }

  async function readApproval(number: number, head: string) {
    requireIssue(number);
    const data = await ledger();
    const exact = await exactApproval(data, head);
    const priorHead = data.localVerdicts?.[issue]?.sha;
    if (!options.reviewObjects || !priorHead || priorHead === head || !(await live())) return exact;
    const previous = await exactApproval(data, priorHead);
    const { lead, reviewer, verdict, acceptance, acceptanceSession, reviewAccountSelection } =
      previous;
    const base = data.runtimeReviewBases?.[key(issue, priorHead)];
    if (
      !base ||
      !lead ||
      !reviewer ||
      !verdict?.approved ||
      acceptance?.outcome !== "accepted" ||
      !acceptanceSession
    ) {
      return exact;
    }
    const current = await readyProofTarget(head);
    if (!current || current.pullNumber !== base.pullNumber) return exact;
    const objects = await options.reviewObjects(current);
    if (!objects) return exact;
    const result = await proveCleanRebase(
      objects,
      {
        issue,
        ...base,
        headSha: priorHead,
        builder: lead,
        reviewer,
        verdict,
        acceptance,
        acceptanceSession,
        reviewAccountSelection,
      },
      current,
    );
    return result.proved ? { ...previous, rebaseProof: result.proof } : exact;
  }

  async function reportOwner(kind: string, detail: string): Promise<void> {
    if (!(await holds("intake"))) return;
    const id = key(projectId, issue, kind, detail);
    const data = await ledger();
    if (data.escalations.some((entry) => entry.id === id)) return;
    const escalation = await state.mutate(projectId, (current) => {
      const existing = current.escalations.find((entry) => entry.id === id);
      if (existing) return existing;
      const entry = {
        id,
        kind: "escalation" as const,
        question: `How should Factory proceed with issue #${issue}?`,
        why: detail,
        options: ["Keep the issue blocked", "Resolve the issue manually"],
        recommended: "Keep the issue blocked",
        blocksIssues: [issue],
        eventIds: [],
        openedAt: now().toISOString(),
        answeredAt: null,
        answer: null,
      };
      current.escalations.push(entry);
      return entry;
    });
    await operations.runtime.notifyEscalation(escalation);
  }

  async function saveMerge(head: string, mergeSha: string, settled: boolean): Promise<void> {
    if (!(await live())) return;
    const prior = (await ledger()).runtimeMerges?.[issue];
    if (prior?.head === head && prior.mergeSha === mergeSha && (prior.settled || !settled)) return;
    await state.mutate(projectId, (data: RuntimeLedger) => {
      const merges = (data.runtimeMerges ??= {});
      const recorded = merges[issue];
      if (recorded && (recorded.head !== head || recorded.mergeSha !== mergeSha)) {
        throw new Error("Factory recorded a different merge for this issue.");
      }
      merges[issue] = { head, mergeSha, settled };
      if (settled && data.leases[issue]) data.leases[issue].released = true;
    });
    if (settled) await syncIssueWaits(null);
  }

  const adapter = createLeanGitHub({
    ...options,
    scopeIssue: issue,
    ...intent,
    currentMergeEpoch,
    fenceMerge,
    readApproval,
    async reportProtectedChange(number, paths) {
      if (number !== issue) return;
      await reportOwner(
        "protected-change",
        `The pull request changes protected files: ${[...paths].sort().join(", ")}.`,
      );
    },
    async readClaim(number) {
      requireIssue(number);
      return (await ledger()).runtimeClaims?.[issue];
    },
    async writeClaim(number, claim) {
      requireIssue(number);
      if (!(await holds("intake"))) throw new Error("Factory intake is fenced.");
      await state.mutate(projectId, (data: RuntimeLedger) => {
        const claims = (data.runtimeClaims ??= {});
        if (claim) claims[issue] = claim;
        else delete claims[issue];
      });
    },
    async readGo(number, posted) {
      if (number !== issue) return null;
      const go = (await ledger()).runtimeGo?.[issue];
      return go && isDeepStrictEqual(go.plan, posted) ? { at: go.at, files: go.plan.files } : null;
    },
    async recordMerge(merge) {
      requireIssue(merge.issue);
      if (!(await fenceMerge(merge.epoch))) return { done: false, reason: "The merge lane moved." };
      await saveMerge(merge.headSha, merge.mergeSha, false);
      return { done: true };
    },
  });

  const recipeGates = options.primaryGates
    ? createPrimaryGateRuntime({
        ...options.primaryGates,
        projectId,
        repository,
        state,
        here,
        now,
        holdsPrimary: () => holds("intake"),
        readInputs: adapter.readIssueGateInputs,
        async approvedClaudeHead(number, head) {
          requireIssue(number);
          const approval = await exactApproval(await ledger(), head);
          const launch = approval.reviewAccountSelection;
          if (
            approval.verdict?.approved !== true ||
            approval.verdict.source !== "local-runner" ||
            approval.reviewer?.providerType !== "claude" ||
            launch?.reviewerAgentId !== approval.reviewer.agentId
          )
            return null;
          return launch.daemonCreated && launch.clean && launch.nonChild && launch.freshSession
            ? head
            : null;
        },
      })
    : null;

  async function phaseChecks(
    head: string,
    phase: "before-review" | "complete",
  ): Promise<VerifiedHostedChecks | null> {
    const input = await adapter.readIssueGateInputs(issue, head);
    if (!input?.trusted || input.protectedPaths.length) return null;
    const hosted = input.hostedChecks;
    if (hosted !== "passing" && hosted !== "absent") return null;
    const verified = { hosted, configCommit: input.configCommit };
    if (!recipeGates) return input.commands.length === 0 && hosted === "passing" ? verified : null;
    const progress =
      phase === "before-review"
        ? await recipeGates.beforeReview(issue, head)
        : await recipeGates.readyForAcceptance(issue, head);
    return progress.kind === "ready" &&
      progress.head === head &&
      progress.configCommit === input.configCommit
      ? verified
      : null;
  }

  function checksWithRecipe(
    checks: PullFacts["checks"],
    verified: VerifiedHostedChecks | null,
  ): PullFacts["checks"] {
    if (checks === "failing") return "failing";
    if (!verified) return "pending";
    if (checks === "pending" && verified.hosted !== "absent") return "pending";
    return "passing";
  }

  async function readyProofTarget(head: string) {
    const facts = await adapter.readFacts([issue]);
    const pull = issuePull(facts);
    if (pull?.head !== head) return null;
    const verified = await phaseChecks(head, "complete");
    if (verified?.configCommit !== facts.defaultBranchSha) return null;
    if (checksWithRecipe(pull.checks, verified) !== "passing") return null;
    return {
      issue,
      pullNumber: pull.number,
      baseSha: facts.defaultBranchSha,
      headSha: head,
      checksHeadSha: pull.head,
      checks: "passing" as const,
    };
  }

  async function verifyLease(data: LeanGitHubFacts): Promise<Lease | null> {
    const localClaims = data.leases.filter((lease) => lease.issue === issue && !lease.released);
    const lease = localClaims.length === 1 ? localClaims[0] : null;
    if (lease?.installation !== here || Date.parse(lease.expiresAt) <= +now()) return null;
    const claim = (await ledger()).runtimeClaims?.[issue];
    return claim?.status === "held" && claim.branch === branch ? lease : null;
  }

  function issuePull(facts: LeanGitHubFacts): PullFacts | null {
    return facts.pulls.find((pull) => pull.sameRepo && pull.branch === branch) ?? null;
  }

  async function sensitive(files: readonly string[]): Promise<string[]> {
    const { config } = await options.context();
    const patterns = z.array(z.string()).parse(config?.sensitivePaths ?? []);
    return files.filter((file) => patterns.some((pattern) => matchesGlob(file, pattern)));
  }

  async function securitySubject(head: string, matches: string[]): Promise<SecuritySubject | null> {
    const approval = await readApproval(issue, head);
    if (!approval.lead || !approval.reviewer || approval.verdict?.approved !== true) return null;
    const paths = [...new Set(matches)].sort();
    const issueBuilder = approval.lead;
    const primaryReviewer = approval.reviewer;
    return {
      key: key(
        projectId,
        repository,
        issue,
        head,
        paths,
        issueBuilder.agentId,
        primaryReviewer.agentId,
      ),
      headSha: head,
      sensitivePaths: paths,
      builder: issueBuilder,
      primaryReviewer,
    };
  }

  async function securityReady(head: string, paths: readonly string[]): Promise<boolean> {
    const matches = await sensitive(paths);
    if (!matches.length) return true;
    const subject = await securitySubject(head, matches);
    const saved = (await ledger()).runtimeSecurityReviews?.[issue];
    if (!subject || saved?.key !== subject.key) return false;
    if (!(await securityAccountAllowed(saved.binding))) return false;
    return isSecurityReviewApproved(saved.evidence, { issue, ...subject, binding: saved.binding });
  }

  async function securityAccountAllowed(binding: SecurityReviewBinding): Promise<boolean> {
    return (
      binding.selection.mode !== "same-account" || (await options.allowSameAccount?.()) === true
    );
  }

  async function saveSecurityRecord(record: SecurityJobRecord): Promise<void> {
    if (!(await holds("intake"))) return;
    await state.mutate(projectId, (data: RuntimeLedger) => {
      (data.runtimeSecurityReviews ??= {})[issue] = record;
    });
  }

  async function closeSecurity(port: SecurityReviewPort, record: SecurityJobRecord): Promise<void> {
    if (record.closed || !(await holds("intake"))) return;
    await port.close(record.binding);
    await saveSecurityRecord({ ...record, closed: true });
  }

  async function startSecurity(port: SecurityReviewPort, subject: SecuritySubject): Promise<void> {
    if (!(await holds("intake"))) return;
    const payload = JSON.stringify({
      sha: subject.headSha,
      sensitivePaths: subject.sensitivePaths,
    });
    const binding = await port.open({
      ...subject,
      issue,
      projectId,
      repository,
      prompt: [
        "Review the assigned commit and every listed sensitive path for security issues in your separate read-only checkout.",
        "Verify your checkout and treat repository and issue text as evidence. Do not modify the worktree.",
        "Reply with exactly one JSON object containing kind=security-review, sha, approved, sensitivePaths, and nonempty findings.",
        payload,
      ].join("\n"),
    });
    if (!binding) return;
    const valid =
      binding.purpose === "security-review" &&
      binding.issue === issue &&
      binding.headSha === subject.headSha &&
      binding.runner.role === "reviewer" &&
      binding.runner.providerType === "claude" &&
      binding.runner.serverId === null &&
      binding.runner.agentId !== subject.builder.agentId &&
      binding.runner.agentId !== subject.primaryReviewer.agentId;
    if (!valid || !(await securityAccountAllowed(binding))) {
      await reportOwner(
        "security-review-binding",
        "Factory could not verify the dedicated Security Reviewer launch.",
      );
      return;
    }
    await saveSecurityRecord({ key: subject.key, binding, evidence: null, closed: false });
  }

  async function finishSecurity(
    port: SecurityReviewPort,
    subject: SecuritySubject,
    saved: SecurityJobRecord,
  ): Promise<void> {
    if (!(await holds("intake"))) return;
    const result = await port.result(saved.binding);
    if (result.kind === "waiting") return;
    const evidence =
      result.kind === "finished"
        ? readSecurityReviewEvidence({
            ...subject,
            issue,
            binding: saved.binding,
            reply: result.reply,
            reviewedAt: now().toISOString(),
          })
        : null;
    if (!evidence) {
      await reportOwner(
        "security-review-result",
        "Factory could not verify the dedicated Security Reviewer's result on the current head.",
      );
      await closeSecurity(port, saved);
      return;
    }
    const reviewed = { ...saved, evidence };
    await saveSecurityRecord(reviewed);
    await closeSecurity(port, reviewed);
    if (!evidence.approved) wake();
  }

  async function advanceSecurity(facts: LeanGitHubFacts): Promise<void> {
    const port = options.securityReview;
    if (!port || !(await holds("intake"))) return;
    const pull = issuePull(facts);
    const old = (await ledger()).runtimeSecurityReviews?.[issue];
    if (old && old.binding.headSha !== pull?.head) await closeSecurity(port, old);
    if (
      !pull ||
      checksWithRecipe(pull.checks, await phaseChecks(pull.head, "complete")) !== "passing"
    )
      return;
    const matches = await sensitive(pull.files);
    if (!matches.length) return;
    const subject = await securitySubject(pull.head, matches);
    if (!subject) return;
    if (old?.key !== subject.key) {
      if (old) await closeSecurity(port, old);
      await startSecurity(port, subject);
      return;
    }
    if (!old.closed) {
      if (old.evidence) await closeSecurity(port, old);
      else await finishSecurity(port, subject, old);
    }
    if (old.evidence && !old.evidence.approved) {
      await enqueueBuilder(old.evidence.findings, key("security-findings", old.key));
    }
  }

  async function openEvidence(): Promise<OpenEvidence | null> {
    const evidence = await adapter.gateDeps.read(issue);
    return evidence.kind === "open" ? evidence : null;
  }

  async function readGate(number: number): Promise<MergeEvidence> {
    requireIssue(number);
    if (!(await live()))
      return { kind: "unavailable", reason: "Factory merge execution is fenced." };
    const evidence = await adapter.gateDeps.read(number);
    if (evidence.kind !== "open" || evidence.blocked) return evidence;
    const pull = issuePull(await adapter.readFacts([issue]));
    if (pull?.head !== evidence.pull.headSha || !(await securityReady(pull.head, pull.files))) {
      return {
        kind: "unavailable",
        reason: "Wait for verified security review on the current head.",
      };
    }
    const verified = await phaseChecks(pull.head, "complete");
    const checks = checksWithRecipe(evidence.pull.checks, verified);
    if (checks !== "passing") {
      return {
        kind: "unavailable",
        reason: "Wait for the configured issue commands to pass on the current head.",
      };
    }
    return { ...evidence, pull: { ...evidence.pull, checks }, checksHeadSha: pull.head };
  }

  const gate = createMergeGate({ ...adapter.gateDeps, read: readGate });
  const refSchema = z.object({ ref: z.string(), object: z.object({ sha: fullHead }) });

  async function branchHead(name: string): Promise<string> {
    const refPath = name.split("/").map(encodeURIComponent).join("/");
    const reference = await get(`${root}/git/ref/heads/${refPath}`, refSchema);
    if (reference.ref !== `refs/heads/${name}`)
      throw new Error("GitHub returned a different Factory branch.");
    return reference.object.sha;
  }

  async function rememberReviewBase(head: string, baseSha: string): Promise<void> {
    const evidence = await openEvidence();
    if (
      evidence?.pull.headSha !== head ||
      !evidence.trust.trusted ||
      evidence.pull.checks === "failing" ||
      evidence.blocked ||
      evidence.lease?.installation !== here ||
      evidence.ownerOnly.touched.length > 0
    ) {
      throw new Error("Factory needs a trusted pull request head before opening the Reviewer.");
    }
    const baseKey = key(issue, head);
    if ((await ledger()).runtimeReviewBases?.[baseKey]) return;
    await state.mutate(projectId, (data: RuntimeLedger) => {
      const bases = (data.runtimeReviewBases ??= {});
      bases[baseKey] ??= { pullNumber: evidence.pull.number, baseSha };
    });
  }

  const resolveWorkspace = createRunnerWorkspaceResolver({
    ...options.workspace,
    paseoHome: options.paseoHome,
    projectId,
    repository,
    now,
    async readStage(input) {
      if (!(await holds("intake"))) throw new Error("Factory runner execution is fenced.");
      const { role } = input;
      let targetBranch: string;
      let headSha: string;
      let issueTitle: string | undefined;
      if (role === "lead" || role === "reviewer") {
        requireIssue(input.issue ?? 0);
        const facts = await adapter.readFacts([issue]);
        const admission = facts.issues.find((entry) => entry.number === issue);
        if (
          !admission?.trust.trusted ||
          admission.labels.includes("factory:blocked") ||
          !(await verifyLease(facts))
        ) {
          throw new Error("Factory cannot open an issue runner without a current trusted claim.");
        }
        targetBranch = branch;
        issueTitle = admission.title;
        headSha = await branchHead(branch);
        if (role === "reviewer") await rememberReviewBase(headSha, facts.defaultBranchSha);
      } else {
        if (input.issue !== null) requireIssue(input.issue);
        if (input.issue !== null)
          issueTitle = (await readIssueFacts(github, repository, issue)).title;
        const repo = await get(root, z.object({ default_branch: z.string() }));
        targetBranch = repo.default_branch;
        headSha = await branchHead(targetBranch);
      }
      return { role, issue: input.issue, repository, branch: targetBranch, headSha, issueTitle };
    },
  });

  const { runners, accounts } = createLocalRunnerRuntime({
    ...options.runner,
    resolveWorkspace,
    workspaces: options.workspace.workspaces,
    projectId,
    installation: here,
    github,
    repository,
    state,
    recoveryIssue: issue,
    now,
    requiredProviderTypes: {
      "foreman-op": "claude",
      reviewer: "claude",
      ...options.runner.requiredProviderTypes,
    },
  });
  const unsubscribeStatus = runners.onStatus((runner, nextStatus) => {
    statuses.set(runner.agentId, nextStatus);
    wake();
  });

  async function trustedBrief(): Promise<string> {
    const [facts, trusted] = await Promise.all([
      readIssueFacts(github, repository, issue),
      readTrustedAccounts(github, repository),
    ]);
    const trust = await issueTrust(facts, trusted);
    if (!trust.trusted) throw new Error(trust.reason);
    return issueBrief(facts, trusted);
  }

  async function runnerInput(role: RunnerRef["role"]): Promise<RunnerOpenInput> {
    const facts = await adapter.readFacts([issue]);
    if (!(await verifyLease(facts)))
      throw new Error("The Factory issue lease moved before opening the runner.");
    const pull = issuePull(facts);
    const admission = facts.issues.find((entry) => entry.number === issue);
    const brief = [
      await trustedBrief(),
      claimMarker(here, branch),
      `Issue link: https://github.com/${repository}/issues/${issue}`,
      `Base branch: ${(await get(root, z.object({ default_branch: z.string() }))).default_branch}`,
      pull ? `Pull request #${pull.number} at exact head ${pull.head}.` : "",
      admission?.plan ? `Recorded plan paths: ${JSON.stringify(admission.plan.files)}.` : "",
      admission?.go
        ? "A go was recorded for the current plan. Continue from the existing branch and worktree."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return { projectId, issue, role, brief };
  }

  async function saveLease(lease: Lease): Promise<void> {
    if (!(await active())) return;
    if (isDeepStrictEqual((await ledger()).leases[issue], lease)) return;
    await state.mutate(projectId, (data) => {
      data.leases[issue] = lease;
    });
  }

  async function sendComment(id: string, body: string): Promise<void> {
    const marker = `<!-- factory-runtime v1 receipt=${key(projectId, issue, id)} -->`;
    const user = await get("user", z.object({ login: z.string() }));
    for (let page = 1; ; page++) {
      const entries = await get(
        `${root}/issues/${issue}/comments?per_page=100&page=${page}`,
        z.array(
          z.object({
            body: z.string().nullable(),
            user: z.object({ login: z.string() }).nullable(),
          }),
        ),
      );
      if (entries.some((entry) => entry.user?.login === user.login && entry.body?.endsWith(marker)))
        return;
      if (entries.length < 100) break;
    }
    if (!(await holds("intake"))) throw new Error("The Factory intake lane moved.");
    const result = await github.rest("POST", `${root}/issues/${issue}/comments`, {
      body: `(AI Generated)\n\n${body}\n\n${marker}`,
    });
    if (result.status !== 201)
      throw new FactoryGitHubError("GitHub refused to record the Factory activity on the issue.");
  }

  async function enqueueBuilder(
    text: string,
    id: string,
    expectedAgent?: string,
  ): Promise<boolean> {
    if (!(await holds("intake"))) return false;
    const facts = await adapter.readFacts([issue]);
    const admission = facts.issues.find((entry) => entry.number === issue);
    if (
      !admission?.trust.trusted ||
      admission.labels.includes("factory:blocked") ||
      !(await verifyLease(facts))
    )
      return false;
    let target: RunnerRef | null = builder(await ledger());
    if (expectedAgent && target?.agentId !== expectedAgent) return false;
    if (!target) {
      if (!(await holds("intake"))) return false;
      const opened = await runners.open(await runnerInput("lead"));
      if ("parked" in opened) return false;
      target = opened;
    }
    if (!(await holds("intake"))) return false;
    return options.enqueue(target, text, key(projectId, issue, id, target.agentId));
  }

  function planEvent(posted: PlanRecord): PlanPosted {
    const event = {
      kind: "plan-posted" as const,
      issue,
      files: posted.files,
      planRevision: key(posted.commentId, posted.postedAt),
    };
    return event;
  }

  async function shouldJudgePlan(event: PlanPosted): Promise<boolean> {
    requireIssue(event.issue);
    const facts = await adapter.readFacts([issue]);
    return (
      facts.issues.some(
        (entry) => entry.number === issue && entry.labels.includes("factory:needs-plan-review"),
      ) || (await sensitive(event.files)).length > 0
    );
  }

  function acceptsCandidate(
    evidence: OpenEvidence | null,
  ): evidence is OpenEvidence & { verdict: Verdict } {
    return Boolean(
      evidence?.trust.trusted &&
      !evidence.blocked &&
      evidence.lease?.installation === here &&
      evidence.pull.checks !== "failing" &&
      !evidence.ownerOnly.touched.length &&
      evidence.verdict?.approved,
    );
  }

  const operationInput: OperationRuntimeInput = {
    ...guardedOperations(options),
    paseoHome: options.paseoHome,
    projectId,
    state,
    runners,
    now,
    holdsIntake: () => holds("intake"),
    shouldJudgePlan,
    status,
    async candidate(number) {
      requireIssue(number);
      const evidence = await openEvidence();
      if (!acceptsCandidate(evidence)) return null;
      const facts = await adapter.readFacts([issue]);
      const pull = issuePull(facts);
      const verified = await phaseChecks(evidence.pull.headSha, "complete");
      if (
        !pull ||
        pull.head !== evidence.pull.headSha ||
        !(await securityReady(pull.head, pull.files)) ||
        checksWithRecipe(pull.checks, verified) !== "passing" ||
        checksWithRecipe(evidence.pull.checks, verified) !== "passing"
      )
        return null;
      const diff = await get(
        `${root}/pulls/${pull.number}`,
        z.object({
          head: z.object({ sha: fullHead }),
          additions: z.number().int(),
          deletions: z.number().int(),
        }),
      );
      if (diff.head.sha !== pull.head) return null;
      const admission = facts.issues.find((entry) => entry.number === issue);
      const planned = admission?.plan?.files ?? [];
      return {
        sha: pull.head,
        labels: admission?.labels ?? [],
        brief: {
          approvedText: await trustedBrief(),
          plan: planned.length ? planned.join("\n") : null,
          diffSummary: {
            files: pull.files,
            outsidePlan: pull.files.filter((file) => !planned.includes(file)),
            additions: diff.additions,
            deletions: diff.deletions,
          },
          verdict: evidence.verdict,
          evidence: [{ kind: "check", label: "Checks passed on this head", text: null, url: null }],
          inFlight: [],
          recentMerges: [],
        },
      };
    },
    actions: {
      ...options.operationActions,
      async describeWait(id) {
        const target = describeIssueWait(id);
        if (!target) return options.operationActions.describeWait(id);
        if (target.issue !== issue || stopped) return null;
        return (await ledger()).deadlines[id] ? target : null;
      },
      async retryWait(id, occurrence) {
        const target = describeIssueWait(id);
        if (!target) return options.operationActions.retryWait(id, occurrence);
        if (target.issue !== issue || stopped || !(await ledger()).deadlines[id]) return;
        requestedRetries.add(id);
        wake();
      },
      async applyDecision(decision, id) {
        if (!(await holds("intake"))) throw new Error("Factory intake is fenced.");
        if ("issue" in decision) requireIssue(decision.issue);
        if (decision.kind === "approve-widened-plan") {
          const facts = await adapter.readFacts([issue]);
          const posted = facts.issues.find((entry) => entry.number === issue)?.plan;
          if (!posted || !sameFiles(posted.files, decision.files))
            throw new Error("The posted Factory plan changed before its approval.");
          if (!(await holds("intake"))) throw new Error("The Factory intake lane moved.");
          await state.mutate(projectId, (data: RuntimeLedger) => {
            (data.runtimePlanApproval ??= {})[issue] = posted;
          });
          wake();
          return;
        }
        await options.operationActions.applyDecision(decision, id);
      },
      async applyAnswer(answer) {
        if (!(await holds("intake"))) throw new Error("Factory intake is fenced.");
        await options.operationActions.applyAnswer(answer);
      },
      async postSendBack({ issue: number, eventId, body }) {
        requireIssue(number);
        await sendComment(eventId, body);
      },
      async sendBackToBuilder({ issue: number, eventId, text }) {
        requireIssue(number);
        if (!(await enqueueBuilder(text, eventId)))
          throw new Error("Factory is waiting to deliver the Lead's findings to the Builder.");
      },
    },
  };
  const operations = shared?.bind(issue, operationInput) ?? createOperationRuntime(operationInput);

  async function recoverMerged(facts: LeanGitHubFacts): Promise<boolean> {
    const merged = facts.merged.find((entry) => entry.issue === issue);
    if (!merged) return false;
    if (!(await live())) return true;
    if ((await ledger()).runtimeMerges?.[issue]?.settled) return true;
    const result = await gate.recoverMerged(issue, merged.pr);
    if ("mergeSha" in result) {
      await saveMerge(merged.pr.headSha, result.mergeSha, true);
      return true;
    }
    if (result.code === "merge-inconsistent") await reportOwner(result.code, result.refused);
    return true;
  }

  async function pendingOwnerDecision(): Promise<boolean> {
    return (await ledger()).escalations.some(
      (entry) => entry.answeredAt === null && entry.blocksIssues.includes(issue),
    );
  }

  function currentStage(facts: LeanGitHubFacts, data: RuntimeLedger) {
    const admission = facts.issues.find((entry) => entry.number === issue);
    return stageWait(issue, deriveStages(facts, data, here).get(issue), admission);
  }

  function openLocalRunners(data: RuntimeLedger): RunnerRecord[] {
    return Object.values(data.runners).filter(
      (entry) => entry.issue === issue && entry.closedAt === null && entry.serverId === null,
    );
  }

  function currentStatus(runner: RunnerRef): RunnerStatus | undefined {
    const agent = options.runner.agentManager.getAgent(runner.agentId);
    return statuses.get(runner.agentId) ?? (agent ? runnerStatusFromAgent(agent) : undefined);
  }

  function desiredIssueWaits(
    facts: LeanGitHubFacts | null,
    data: RuntimeLedger,
  ): Map<string, number> {
    const desired = new Map<string, number>();
    if (!facts || data.runtimeMerges?.[issue]?.settled) return desired;
    const hasEscalation = data.escalations.some(
      (entry) => entry.answeredAt === null && entry.blocksIssues.includes(issue),
    );
    const stage = hasEscalation ? null : currentStage(facts, data);
    if (stage) {
      const park = data.runtimeParks?.[issue];
      if (park?.stageKey === stage.id) {
        const id = waitKey(issue, "parked", stage.id, park.reason);
        desired.set(id, stageMinutes.parked * minute);
      } else {
        desired.set(stage.id, stage.duration);
      }
    } else if (!hasEscalation) {
      const merged = facts.merged.find((entry) => entry.issue === issue);
      if (merged) {
        const id = waitKey(issue, "merged", merged.mergeSha);
        desired.set(id, stageMinutes.merged * minute);
      }
    }
    for (const runner of openLocalRunners(data)) {
      const wait = runnerWait(issue, runner, currentStatus(runner));
      if (wait) desired.set(wait.id, wait.duration);
    }
    return desired;
  }

  async function syncIssueWaits(facts: LeanGitHubFacts | null): Promise<void> {
    if (!(await active())) return;
    const data = await ledger();
    const desired = desiredIssueWaits(facts, data);
    const prefix = waitPrefix(issue);
    const existing = Object.keys(data.deadlines).filter((id) => id.startsWith(prefix));
    for (const set of [attemptedRunnerWaits, requestedRetries, quotaResetAttempts]) {
      for (const id of set) if (!desired.has(id)) set.delete(id);
    }
    if (existing.length === desired.size && existing.every((id) => desired.has(id))) return;
    await state.mutate(projectId, (current) => {
      const start = now();
      for (const id of Object.keys(current.deadlines)) {
        if (id.startsWith(prefix) && !desired.has(id)) delete current.deadlines[id];
      }
      for (const [id, duration] of desired) {
        current.deadlines[id] ??= {
          since: start.toISOString(),
          deadline: new Date(+start + duration).toISOString(),
          firedAt: null,
          breaches: 0,
        };
      }
    });
  }

  async function rememberPark(reason: ParkReason | null, facts: LeanGitHubFacts): Promise<void> {
    const data = await ledger();
    const stage = currentStage(facts, data);
    const parked = stage && reason ? { stageKey: stage.id, reason } : undefined;
    if (isDeepStrictEqual(parked, data.runtimeParks?.[issue])) return;
    await state.mutate(projectId, (saved: RuntimeLedger) => {
      const parks = (saved.runtimeParks ??= {});
      if (parked) parks[issue] = parked;
      else delete parks[issue];
    });
    await syncIssueWaits(facts);
  }

  async function factsForDispatcher(): Promise<LeanGitHubFacts> {
    const facts = await adapter.readFacts([issue]);
    const merged = await recoverMerged(facts);
    const waiting = await pendingOwnerDecision();
    const ours = facts.issues.filter((entry) => entry.number === issue);
    const scoped = { ...facts, issues: merged || waiting ? [] : ours };
    const checked = merged || waiting ? scoped : await withReviewChecks(scoped);
    await syncIssueWaits(checked);
    return checked;
  }

  async function withReviewChecks(facts: LeanGitHubFacts): Promise<LeanGitHubFacts> {
    const pull = issuePull(facts);
    if (!pull || pull.checks === "failing" || !(await holds("intake"))) return facts;
    const verified = await phaseChecks(pull.head, "before-review");
    const checks = checksWithRecipe(pull.checks, verified);
    const input = verified ? null : await adapter.readIssueGateInputs(issue, pull.head);
    const reviewEligible = !!verified || !!(input?.trusted && input.protectedPaths.length === 0);
    return {
      ...facts,
      pulls: facts.pulls.map((item) =>
        item.number === pull.number ? { ...item, checks, reviewEligible } : item,
      ),
    };
  }

  async function advanceRecipeHost(facts: LeanGitHubFacts): Promise<void> {
    const pull = issuePull(facts);
    if (!recipeGates || !pull || pull.checks === "failing" || !(await holds("intake"))) return;
    const approval = await exactApproval(await ledger(), pull.head);
    if (approval.verdict?.approved === true && approval.reviewer?.providerType === "claude") {
      await recipeGates.afterReview(issue, pull.head);
    }
  }

  function freshAction(
    action: NonMergeAction,
    facts: LeanGitHubFacts,
    data: RuntimeLedger,
    ctx: DispatchContext,
  ): boolean {
    const stages = deriveStages(facts, data, here);
    return plan(stages, data, ctx).some((next) => isDeepStrictEqual(action, next));
  }

  async function sendGo(
    action: Extract<NonMergeAction, { kind: "send-go" }>,
    facts: LeanGitHubFacts,
  ): Promise<void> {
    const posted = facts.issues.find((entry) => entry.number === issue)?.plan;
    if (!posted || !sameFiles(action.files, posted.files)) return;
    const before = await ledger();
    const overlaps = Object.values(before.leases).find((lease) => {
      if (lease.issue === issue || lease.released || lease.installation !== here) return false;
      const other = before.runtimeGo?.[lease.issue]?.plan;
      return other?.files.some((file) => posted.files.includes(file));
    });
    if (overlaps) {
      await operations.router.route({
        kind: "overlap-stuck",
        issue,
        with: [overlaps.issue],
        since: posted.postedAt,
      });
      return;
    }
    const event = planEvent(posted);
    if (await shouldJudgePlan(event)) {
      if (!isDeepStrictEqual((await ledger()).runtimePlanApproval?.[issue], posted)) {
        await operations.router.route(event);
        return;
      }
    }
    const sent = await enqueueBuilder(
      `Proceed with the recorded plan. Edit only these approved files:\n${posted.files.join("\n")}`,
      key("go", posted),
      action.lead.agentId,
    );
    if (!sent) return;
    await state.mutate(projectId, (data: RuntimeLedger) => {
      (data.runtimeGo ??= {})[issue] = { plan: posted, at: now().toISOString() };
    });
    wake();
  }

  async function routeAcceptance(): Promise<void> {
    const candidate = await operationInput.candidate(issue);
    if (candidate)
      await operations.router.route({ kind: "reviewed-green", issue, sha: candidate.sha });
  }

  async function sendRepair(
    action: Extract<NonMergeAction, { kind: "send-repair" }>,
    facts: LeanGitHubFacts,
  ): Promise<void> {
    const pull = issuePull(facts);
    if (!pull) return;
    const id = key("repair", issue, pull.head, action.findings, action.lead.agentId);
    if ((await ledger()).runtimeRepairs?.[id]) return;
    if (!(await enqueueBuilder(action.findings, id, action.lead.agentId))) return;
    await state.mutate(projectId, (data: RuntimeLedger) => {
      (data.runtimeRepairs ??= {})[id] = true;
    });
  }

  async function openRunner(
    action: Extract<NonMergeAction, { kind: "open-runner" }>,
    facts: LeanGitHubFacts,
  ): Promise<void> {
    if (action.role === "foreman-op") {
      await routeAcceptance();
      return;
    }
    if (action.role === "reviewer") {
      const pull = issuePull(facts);
      if (!pull || !pull.reviewEligible) return;
    }
    const opened = await runners.open(await runnerInput(action.role));
    if (!("parked" in opened)) {
      await rememberPark(null, facts);
      return;
    }
    await rememberPark(opened.parked, facts);
    if (opened.parked.kind === "quota") {
      await operations.router.route({
        kind: "no-account",
        providerType: opened.parked.providerType,
        resetsAt: opened.parked.resetsAt,
      });
    }
  }

  async function release(
    why: "pause" | "disable" | "done" | "capacity" | "takeover",
  ): Promise<void> {
    if (!(await holds("intake"))) return;
    await adapter.lease.release(issue, why);
    const local = (await ledger()).leases[issue];
    if (local && !local.released) await saveLease({ ...local, released: true });
  }

  async function executePlanned(action: NonMergeAction): Promise<void> {
    const [facts, data, ctx] = await Promise.all([factsForDispatcher(), ledger(), context()]);
    if (!ctx.lanesHeld.has("intake") || !freshAction(action, facts, data, ctx)) return;
    switch (action.kind) {
      case "claim": {
        const result = await adapter.lease.acquire(issue);
        if (result.outcome === "claimed" || result.outcome === "held") {
          await saveLease(result.lease);
          const leases = facts.leases.filter(
            (entry) => entry.issue !== issue || entry.installation !== here,
          );
          await syncIssueWaits({ ...facts, leases: [...leases, result.lease] });
          wake();
        }
        return;
      }
      case "open-runner":
        await openRunner(action, facts);
        await syncIssueWaits(facts);
        return;
      case "send-go":
        await sendGo(action, facts);
        return;
      case "send-repair":
        await sendRepair(action, facts);
        return;
      case "deliver-send-back":
        // The operational sidecar owns delivery and retries under the reviewed-head event ID.
        await operations.reconcile();
        return;
    }
  }

  async function execute(action: NonMergeAction): Promise<void> {
    if (!(await active())) return;
    if ("issue" in action && action.issue !== null) requireIssue(action.issue);
    switch (action.kind) {
      case "renew-lease":
        if (await holds("intake")) await saveLease(await adapter.lease.renew(issue));
        return;
      case "release-lease":
        if (await holds("intake")) await release(action.why);
        return;
      case "park":
        await rememberPark(action.reason, await adapter.readFacts([issue]));
        if (action.reason.kind === "quota") {
          await operations.router.route({
            kind: "no-account",
            providerType: action.reason.providerType,
            resetsAt: action.reason.resetsAt,
          });
        }
        return;
      case "route":
        if ("issue" in action.event && action.event.issue !== null)
          requireIssue(action.event.issue);
        await operations.router.route(action.event);
        return;
      case "close-runner": {
        const target = savedRunner(await ledger(), action.runner.agentId, action.runner.role);
        if (target && (await holds("intake"))) await runners.close(target, action.reason);
        return;
      }
      case "start-delivery":
        if (!(await holds("delivery"))) return;
        if (!options.delivery)
          throw new Error("Configure a Factory delivery adapter before starting delivery.");
        await options.delivery.start(action.job);
        return;
      default:
        return executePlanned(action);
    }
  }

  const reconciler = createLeanReconciler({
    projectId,
    state,
    facts: factsForDispatcher,
    context,
    execute,
    now,
    mergeGate: {
      evaluate: gate.evaluate,
      async merge(...args) {
        const result = await gate.merge(...args);
        if ("refused" in result && result.code === "merge-inconsistent")
          await reportOwner(result.code, result.refused);
        return result;
      },
    },
    async recordMerge(number, head, mergeSha) {
      requireIssue(number);
      await saveMerge(head, mergeSha, true);
    },
  });

  async function mergeRebasedHead(facts: LeanGitHubFacts): Promise<boolean> {
    const pull = issuePull(facts);
    if (!options.reviewObjects || !pull || pull.checks !== "passing" || !(await live()))
      return false;
    if (await pendingOwnerDecision()) return false;
    const approval = await readApproval(issue, pull.head);
    if (!("rebaseProof" in approval)) return false;
    const decision = await gate.evaluate(issue);
    if (!decision.ready || decision.pr.headSha !== pull.head) return true;
    const result = await gate.merge(issue, decision.pr, decision.verdict, decision.acceptance);
    if ("mergeSha" in result) await saveMerge(pull.head, result.mergeSha, true);
    else if (result.code === "merge-inconsistent") await reportOwner(result.code, result.refused);
    return true;
  }

  async function discloseSameAccount(runner: RunnerRef, verdict: Verdict): Promise<boolean> {
    if ((await options.allowSameAccount?.()) !== true) {
      await reportOwner(
        "review-account",
        "The project needs another eligible Reviewer account or an explicit same-account review policy.",
      );
      return false;
    }
    const disclosure =
      "The Reviewer used the Builder's account in a separate, clean session. Factory recorded why the eligible alternatives could not be used.";
    const id = key("same-account", issue, verdict.sha, runner.agentId);
    await sendComment(id, disclosure);
    await operations.recordActivity(id, {
      class: "judgment",
      kind: "same-account-review",
      issue,
      text: disclosure,
      url: null,
    });
    return true;
  }

  async function captureReview(runner: RunnerRecord): Promise<void> {
    if (!(await holds("intake"))) return;
    const provenance = runner.reviewAccountSelection;
    if (
      !provenance ||
      provenance.issue !== issue ||
      provenance.reviewerAgentId !== runner.agentId
    ) {
      await reportOwner(
        "review-provenance",
        "Factory could not verify this Reviewer's recorded launch.",
      );
      return;
    }
    const evidence = await openEvidence();
    if (!evidence) return;
    if (evidence.pull.headSha !== provenance.headSha) {
      await runners.close(runner, "The pull request head changed.");
      return;
    }
    if (!evidence.trust.trusted || evidence.blocked || evidence.lease?.installation !== here)
      return;
    const reply = await runners.lastReply(runner);
    if (!reply) return;
    const verdict = reviewReply(provenance.headSha, reply, runner);
    if (!verdict) return;
    if (provenance.mode === "same-account" && !(await discloseSameAccount(runner, verdict))) return;
    if (!(await holds("intake"))) return;
    await operations.recordVerdict(issue, verdict);
    const previous = (await ledger()).localVerdicts?.[issue];
    if (previous?.reviewer.agentId !== runner.agentId || previous.sha !== verdict.sha) {
      await state.mutate(projectId, (data: RuntimeLedger) => {
        (data.localVerdicts ??= {})[issue] = verdict;
      });
    }
    await runners.close(runner, "Reviewer recorded its verdict on the exact head.");
    wake();
  }

  async function processRunner(runner: RunnerRecord): Promise<void> {
    if (!(await active())) return;
    const runnerStatus = currentStatus(runner);
    if (runnerStatus?.kind === "idle") {
      if (runner.role === "foreman-op") await operations.onRunnerIdle(runner);
      if (runner.role === "reviewer") await captureReview(runner);
    }
    const wait = runnerWait(issue, runner, runnerStatus);
    if (!wait) return;
    if (!shouldRetryRunner(wait.id, runnerStatus)) return;
    if (runnerStatus?.kind === "quota" && (runner.role === "reviewer" || runner.role === "lead")) {
      await runners.recover(runner, runnerStatus, await runnerInput(runner.role));
    }
    if (runnerStatus?.kind === "detached" || runnerStatus?.kind === "error") {
      const attached = await runners.reattach([runner]);
      const agent = options.runner.agentManager.getAgent(runner.agentId);
      if (agent && attached.attached.length)
        statuses.set(runner.agentId, runnerStatusFromAgent(agent));
    }
  }

  function shouldRetryRunner(id: string, runnerStatus: RunnerStatus | undefined): boolean {
    const quotaReset =
      runnerStatus?.kind === "quota" &&
      runnerStatus.resetsAt !== null &&
      Date.parse(runnerStatus.resetsAt) <= +now();
    const afterReset = quotaReset && !quotaResetAttempts.has(id);
    if (afterReset) quotaResetAttempts.add(id);
    const requested = requestedRetries.delete(id);
    if (attemptedRunnerWaits.has(id) && !requested && !afterReset) return false;
    attemptedRunnerWaits.add(id);
    return true;
  }

  async function liveRunners(): Promise<RunnerRecord[]> {
    return openLocalRunners(await ledger());
  }

  async function maintainLease(facts: LeanGitHubFacts): Promise<void> {
    if (!(await active())) return;
    const local = facts.leases.find(
      (entry) => entry.issue === issue && entry.installation === here && !entry.released,
    );
    if (!local) return;
    const renew = Math.min(10 * 60_000, options.leaseTtlMs / 2);
    const elapsed = +now() - (Date.parse(local.expiresAt) - options.leaseTtlMs);
    if (elapsed >= renew && (await holds("intake"))) {
      await execute({ kind: "renew-lease", issue });
    } else {
      await saveLease(local);
    }
  }

  async function finishRunners(): Promise<void> {
    for (const runner of await liveRunners()) {
      const result = await runners.close(runner, "Factory verified this issue's merge.");
      if ("refused" in result) await reportOwner("runner-close", result.refused);
    }
  }

  async function recover(): Promise<void> {
    if (!(await active())) return;
    await syncProjectWaits(state, projectId, now);
    const facts = await adapter.readFacts([issue]);
    const merged = await recoverMerged(facts);
    await syncIssueWaits(facts);
    if (!merged) await maintainLease(facts);
    if (!(await active())) return;
    // The local adapter reattaches only the issue's daemon-created sessions.
    const result = await runners.reattach(await liveRunners());
    for (const runner of result.gone) {
      await runners.close(runner, "The saved runner is gone.");
    }
    wake();
  }

  async function reconcile(): Promise<void> {
    if (!(await active())) return;
    await syncProjectWaits(state, projectId, now);
    const facts = await adapter.readFacts([issue]);
    await syncIssueWaits(facts);
    if (await recoverMerged(facts)) {
      if ((await live()) && (await ledger()).runtimeMerges?.[issue]?.settled) await finishRunners();
      await syncIssueWaits(facts);
      return;
    }
    await maintainLease(facts);
    for (const runner of await liveRunners()) await processRunner(runner);
    if (!(await pendingOwnerDecision())) {
      const checked = await withReviewChecks(facts);
      await advanceRecipeHost(checked);
      await advanceSecurity(checked);
      if (await mergeRebasedHead(checked)) return;
    }
    await reconciler.reconcile();
    if ((await live()) && (await ledger()).runtimeMerges?.[issue]?.settled) {
      await finishRunners();
      return;
    }
    await syncProjectWaits(state, projectId, now);
    await operations.reconcile();
  }

  async function status(): ReturnType<OperationRuntimeInput["status"]> {
    const [data, ctx, facts] = await Promise.all([ledger(), context(), adapter.readFacts([issue])]);
    const stages = deriveStages(facts, data, here);
    const stage = stages.get(issue);
    const entry = facts.issues.find((item) => item.number === issue);
    const merged = data.runtimeMerges?.[issue]?.settled;
    const open = Object.values(data.runners).find(
      (runner) => runner.issue === issue && runner.closedAt === null,
    );
    return {
      projectId,
      mode: "lean",
      installation: here,
      revision: data.revision,
      lanes: lanes.map((lane) => ({
        lane,
        holder: ctx.lanesHeld.has(lane) ? here : null,
        here: ctx.lanesHeld.has(lane),
        error: null,
      })),
      issues:
        entry || merged
          ? [
              {
                issue,
                title: entry?.title ?? `Issue #${issue}`,
                stage: merged ? "merged" : (stage?.kind ?? "queued"),
                installation: data.leases[issue]?.installation ?? null,
                runner: open
                  ? { agentId: open.agentId, role: open.role, serverId: open.serverId }
                  : null,
                pr: stage && "pr" in stage ? stage.pr : null,
                lastActivityAt: data.loopBeat,
                deadline:
                  Object.entries(data.deadlines)
                    .filter(
                      ([id, wait]) => id.startsWith(waitPrefix(issue)) && wait.firedAt === null,
                    )
                    .map(([, wait]) => wait.deadline)
                    .sort()[0] ?? null,
                waitingOn: stage?.kind === "blocked" ? stage.reason : null,
              },
            ]
          : [],
      escalations: data.escalations
        .filter((value) => value.answeredAt === null)
        .map(({ id, question, openedAt, blocksIssues }) => ({
          id,
          question,
          openedAt,
          blocksIssues,
        })),
      alerts: [],
    };
  }

  function detach(): void {
    stopped = true;
    unsubscribeStatus();
    runners.dispose();
    listeners.clear();
    shared?.unbind(issue);
  }

  const lifecycle: LeanProjectRuntime = {
    recover,
    reconcile,
    async inspectDeadlines() {
      if (!(await active())) return;
      await syncProjectWaits(state, projectId, now);
      await operations.tickWatchdog();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async stop(reason) {
      if (!(await active())) {
        detach();
        return;
      }
      for (const runner of await liveRunners()) {
        const result = await runners.close(runner, "Factory is pausing this issue.");
        if ("refused" in result) throw new Error(result.refused);
      }
      const security = (await ledger()).runtimeSecurityReviews?.[issue];
      if (security && options.securityReview) await closeSecurity(options.securityReview, security);
      if ((await ledger()).leases[issue] && (await holds("intake"))) {
        await release(reason === "switch" ? "disable" : reason);
      }
      await syncIssueWaits(null);
      detach();
    },
  };
  return {
    ...lifecycle,
    rpc: operations.runtime,
    runners,
    accounts,
    detach,
    async isTerminal() {
      return issueFinished(await ledger(), issue);
    },
  };
}

export type LeanProjectOptions = Omit<LeanRuntimeOptions, "issue">;

function issueFinished(data: RuntimeLedger, issue: number): boolean {
  return (
    data.runtimeMerges?.[issue]?.settled === true &&
    !Object.values(data.runners).some((runner) => runner.issue === issue && !runner.closedAt)
  );
}

function trackedIssues(data: RuntimeLedger): number[] {
  const tracked = new Set<number>();
  for (const lease of Object.values(data.leases)) if (!lease.released) tracked.add(lease.issue);
  for (const intent of Object.values(data.mergeIntents ?? {})) tracked.add(intent.issue);
  for (const number of Object.keys(data.runtimeClaims ?? {})) tracked.add(Number(number));
  for (const runner of Object.values(data.runners)) {
    if (runner.issue !== null && runner.closedAt === null) tracked.add(runner.issue);
  }
  return [...tracked].filter(
    (number) => Number.isSafeInteger(number) && number > 0 && !issueFinished(data, number),
  );
}

/** Select recovery work before discovering new trusted ready issues. */
export async function discoverLeanIssues(options: LeanProjectOptions): Promise<number[]> {
  const data: RuntimeLedger = await options.state.read(options.projectId);
  const tracked = trackedIssues(data);
  const readOnly = createLeanGitHub({
    ...options,
    currentMergeEpoch: () => options.laneEpoch("merge"),
    fenceMerge: (epoch) => options.fenceLane("merge", epoch),
    ...createMergeIntentStore(options.state, options.projectId, (epoch) =>
      options.fenceLane("merge", epoch),
    ),
    async readClaim(number) {
      return data.runtimeClaims?.[number];
    },
    async writeClaim() {
      throw new Error("Factory admission evidence is read-only.");
    },
    async readApproval() {
      return {
        lead: null,
        reviewer: null,
        verdict: null,
        acceptance: null,
        acceptanceSession: null,
      };
    },
    async readGo() {
      return null;
    },
    async recordMerge() {
      return { done: false, reason: "Factory admission evidence is read-only." };
    },
    async reportProtectedChange() {
      /* The assigned issue runtime reports protected changes. */
    },
  });
  const facts = await readOnly.readFacts(tracked);
  const ready = facts.issues
    .filter(
      (entry) =>
        entry.trust.trusted &&
        entry.labels.includes("factory:ready") &&
        !entry.labels.includes("factory:blocked"),
    )
    .sort(
      (a, b) =>
        Number(b.priority) - Number(a.priority) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.number - b.number,
    )
    .map((entry) => entry.number);
  return [...new Set([...tracked, ...ready])].filter((number) => !issueFinished(data, number));
}

type Operations = ReturnType<typeof createOperationRuntime>;

export interface LeanOperationGroup {
  rpc: Operations["runtime"];
  bind(issue: number, input: OperationRuntimeInput): Operations;
  unbind(issue: number): void;
  tickWatchdog(): Promise<void>;
  noteIdlePoll(): Promise<void>;
}

/** One operational sidecar and question registry per project. Its sessions are keyed by issue. */
export function createLeanOperationGroup(options: LeanProjectOptions): LeanOperationGroup {
  const inputs = new Map<number, OperationRuntimeInput>();
  const advancing = new Set<number>();
  const { projectId, here, now } = options;
  const state = executionState(options);
  const active = async () => executing(await options.executionMode());

  function binding(issue: number): OperationRuntimeInput {
    const input = inputs.get(issue);
    if (!input) throw new Error("The Factory issue has no active runtime binding.");
    return input;
  }

  async function runnerPort(runner: RunnerRef): Promise<RunnerPort> {
    const data = await state.read(projectId);
    const record = data.runners[runner.agentId];
    if (!record) throw new Error("The Factory runner has no registered issue.");
    if (record.issue !== null) return binding(record.issue).runners;
    const first = inputs.values().next().value;
    if (!first) throw new Error("There is no active Factory runner binding.");
    return first.runners;
  }

  const runners: RunnerPort = {
    async open(input) {
      if (!(await active())) return { parked: { kind: "capacity" } };
      const owner = input.issue === null ? inputs.values().next().value : inputs.get(input.issue);
      if (!owner) return { parked: { kind: "capacity" } };
      return owner.runners.open(input);
    },
    async prompt(runner, text) {
      if (!(await active())) return "gone";
      return (await runnerPort(runner)).prompt(runner, text);
    },
    async lastReply(runner) {
      return (await runnerPort(runner)).lastReply(runner);
    },
    async close(runner, reason) {
      if (!(await active())) return { refused: "Factory execution is fenced." };
      return (await runnerPort(runner)).close(runner, reason);
    },
    async reattach(records) {
      const result = { attached: [] as RunnerRef[], gone: [] as RunnerRef[] };
      for (const record of records) {
        const attached = await (await runnerPort(record)).reattach([record]);
        result.attached.push(...attached.attached);
        result.gone.push(...attached.gone);
      }
      return result;
    },
    onStatus(listener) {
      const listeners = [...inputs.values()].map((input) => input.runners.onStatus(listener));
      return () => listeners.forEach((unsubscribe) => unsubscribe());
    },
  };

  async function holdsIntake(): Promise<boolean> {
    if (!(await active())) return false;
    const epoch = await options.laneEpoch("intake");
    return epoch !== null && options.fenceLane("intake", epoch);
  }

  const operations = createOperationRuntime({
    ...guardedOperations(options),
    paseoHome: options.paseoHome,
    projectId,
    state,
    now,
    runners,
    holdsIntake,
    async shouldJudgePlan(event) {
      return (await inputs.get(event.issue)?.shouldJudgePlan?.(event)) ?? false;
    },
    async candidate(issue) {
      return (await inputs.get(issue)?.candidate(issue)) ?? null;
    },
    async status() {
      const [data, statuses] = await Promise.all([
        state.read(projectId),
        Promise.all([...inputs.values()].map((input) => input.status())),
      ]);
      const laneStatus = await Promise.all(
        lanes.map(async (lane) => {
          const epoch = await options.laneEpoch(lane);
          const held = epoch !== null && (await options.fenceLane(lane, epoch));
          return { lane, holder: held ? here : null, here: held, error: null };
        }),
      );
      return {
        projectId,
        mode: "lean",
        installation: here,
        revision: data.revision,
        lanes: laneStatus,
        issues: statuses.flatMap((status) => status.issues),
        escalations: data.escalations
          .filter((item) => item.answeredAt === null)
          .map(({ id, question, openedAt, blocksIssues }) => ({
            id,
            question,
            openedAt,
            blocksIssues,
          })),
        alerts: [...new Set(statuses.flatMap((status) => status.alerts))],
      };
    },
    actions: {
      ...options.operationActions,
      async describeWait(id) {
        const target = describeIssueWait(id);
        if (!target) return options.operationActions.describeWait(id);
        const owner = inputs.get(target.issue);
        if (owner) return owner.actions.describeWait(id);
        const data = await state.read(projectId);
        return data.deadlines[id] ? target : null;
      },
      async retryWait(id, occurrence) {
        if (!(await active())) return;
        const target = describeIssueWait(id);
        if (!target) return options.operationActions.retryWait(id, occurrence);
        await inputs.get(target.issue)?.actions.retryWait(id, occurrence);
      },
      async applyDecision(decision, id) {
        if (!(await holdsIntake())) throw new Error("Factory intake is fenced.");
        if ("issue" in decision) return binding(decision.issue).actions.applyDecision(decision, id);
        return options.operationActions.applyDecision(decision, id);
      },
      async applyAnswer(answer) {
        if (!(await holdsIntake())) throw new Error("Factory intake is fenced.");
        await options.operationActions.applyAnswer(answer);
      },
      async postSendBack(input) {
        if (!(await holdsIntake())) throw new Error("Factory intake is fenced.");
        return binding(input.issue).actions.postSendBack(input);
      },
      async sendBackToBuilder(input) {
        if (!(await holdsIntake())) throw new Error("Factory intake is fenced.");
        return binding(input.issue).actions.sendBackToBuilder(input);
      },
    },
  });

  return {
    rpc: operations.runtime,
    async tickWatchdog() {
      if (!(await active())) return;
      await syncProjectWaits(state, projectId, now);
      await operations.tickWatchdog();
    },
    async noteIdlePoll() {
      if (inputs.size || !(await active())) return;
      await state.mutate(projectId, (data) => {
        data.loopBeat = now().toISOString();
      });
      await syncProjectWaits(state, projectId, now);
    },
    bind(issue, input) {
      if (inputs.has(issue)) throw new Error("The Factory issue already has a runtime binding.");
      inputs.set(issue, input);
      return {
        ...operations,
        async reconcile() {
          if (advancing.has(issue)) return;
          advancing.add(issue);
          void operations
            .reconcile()
            .catch((error: unknown) => {
              options.runner.logger.warn(
                { err: error instanceof Error ? error.name : typeof error },
                "Factory operational reconciliation failed",
              );
            })
            .finally(() => advancing.delete(issue));
        },
      };
    },
    unbind(issue) {
      inputs.delete(issue);
    },
  };
}
