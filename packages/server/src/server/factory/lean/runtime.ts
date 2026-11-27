import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { claimMarker, FactoryGitHubError } from "../project/claims.js";
import type { ClaimState } from "../project/state.js";
import { issueBrief, issueTrust, readIssueFacts, readTrustedAccounts } from "../project/trust.js";
import type { ReviewAccountSelection } from "./accounts.js";
import { plan } from "./dispatcher.js";
import { createLeanGitHub, type LeanGitHubFacts, type LeanGitHubOptions } from "./github.js";
import { deriveStages, type IssueLedger } from "./issue-state.js";
import { createMergeGate, type MergeEvidence, type MergeIntent } from "./merge-gate.js";
import { createMergeIntentStore } from "./merge-intent.js";
import type { LeanProjectRuntime } from "./mode.js";
import { createOperationRuntime, type OperationRuntimeInput } from "./operation-runtime.js";
import { proveCleanRebase, type ReviewGitObjects } from "./review-evidence.js";
import { createLocalRunnerRuntime, type LocalRunnerDependencies } from "./runner-adapters.js";
import {
  createRunnerWorkspaceResolver,
  type RunnerWorkspaceDependencies,
} from "./runner-workspaces.js";
import { runnerStatusFromAgent } from "./runners.js";
import { createLeanReconciler } from "./service.js";
import type {
  AdmissionFacts,
  DeliveryPort,
  DispatchAction,
  DispatchContext,
  FactoryEvent,
  Lane,
  LeanStateStore,
  Lease,
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

export interface LeanRuntimeOptions extends GitHubOptions {
  projectId: string;
  /** The admitted issue assigned to this rollout of the runtime. */
  issue: number;
  paseoHome: string;
  state: LeanStateStore;
  now(): Date;
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
  /** True only for a separately authenticated security review of this exact head. */
  hasSecurityReview?(issue: number, head: string, paths: readonly string[]): Promise<boolean>;
  /** Read daemon-recorded results for any configured issue commands at this exact head. */
  hasIssueGateEvidence?(issue: number, head: string): Promise<boolean>;
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
  mergeIntents?: Record<string, MergeIntent>;
}

const fullHead = z.string().regex(/^[a-f0-9]{40}$/);
const lanes: Lane[] = ["intake", "merge", "delivery", "releaseBuild", "mechanic"];

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
  const { projectId, issue, state, here, github, repository, now } = options;
  if (!Number.isSafeInteger(issue) || issue < 1)
    throw new Error("Factory needs a valid assigned issue.");
  const branch = `factory/issue-${issue}`;
  const root = `repos/${repository}`;
  const statuses = new Map<string, RunnerStatus>();
  const listeners = new Set<() => void>();
  const wake = () => listeners.forEach((listener) => listener());
  const ledger = (): Promise<RuntimeLedger> => state.read(projectId);
  const fenceMerge = (epoch: number) => options.fenceLane("merge", epoch);
  const currentMergeEpoch = () => options.laneEpoch("merge");
  const intent = createMergeIntentStore(state, projectId, fenceMerge);
  let stopped = false;

  async function holds(lane: Lane): Promise<boolean> {
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
    if (!options.reviewObjects || !priorHead || priorHead === head) return exact;
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
    const facts = await adapter.readFacts([issue]);
    const pull = checkedPull(facts, head);
    if (!pull || pull.number !== base.pullNumber) return exact;
    const current = {
      issue,
      pullNumber: pull.number,
      baseSha: facts.defaultBranchSha,
      headSha: head,
      checksHeadSha: pull.head,
      checks: pull.checks,
    };
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

  async function verifyLease(data: LeanGitHubFacts): Promise<Lease | null> {
    const active = data.leases.filter((lease) => lease.issue === issue && !lease.released);
    const lease = active.length === 1 ? active[0] : null;
    if (lease?.installation !== here || Date.parse(lease.expiresAt) <= +now()) return null;
    const claim = (await ledger()).runtimeClaims?.[issue];
    return claim?.status === "held" && claim.branch === branch ? lease : null;
  }

  function issuePull(facts: LeanGitHubFacts): PullFacts | null {
    return facts.pulls.find((pull) => pull.sameRepo && pull.branch === branch) ?? null;
  }

  function checkedPull(facts: LeanGitHubFacts, head: string): PullFacts | null {
    const pull = issuePull(facts);
    return pull?.head === head && pull.checks === "passing" ? pull : null;
  }

  async function sensitive(files: readonly string[]): Promise<string[]> {
    const { config } = await options.context();
    const patterns = z.array(z.string()).parse(config?.sensitivePaths ?? []);
    return files.filter((file) => patterns.some((pattern) => matchesGlob(file, pattern)));
  }

  async function securityReady(head: string, paths: readonly string[]): Promise<boolean> {
    const matches = await sensitive(paths);
    if (!matches.length) return true;
    return (await options.hasSecurityReview?.(issue, head, matches)) === true;
  }

  async function issueGatesReady(head: string): Promise<boolean> {
    const { config } = await options.context();
    const commands = config?.issueGates;
    if (commands === undefined || (Array.isArray(commands) && commands.length === 0)) return true;
    return (await options.hasIssueGateEvidence?.(issue, head)) === true;
  }

  async function openEvidence(): Promise<OpenEvidence | null> {
    const evidence = await adapter.gateDeps.read(issue);
    return evidence.kind === "open" ? evidence : null;
  }

  async function readGate(number: number): Promise<MergeEvidence> {
    requireIssue(number);
    const evidence = await adapter.gateDeps.read(number);
    if (evidence.kind !== "open" || evidence.blocked) return evidence;
    const pull = issuePull(await adapter.readFacts([issue]));
    if (pull?.head !== evidence.pull.headSha || !(await securityReady(pull.head, pull.files))) {
      return {
        kind: "unavailable",
        reason: "Wait for verified security review on the current head.",
      };
    }
    if (!(await issueGatesReady(pull.head))) {
      return {
        kind: "unavailable",
        reason: "Wait for the configured issue commands to pass on the current head.",
      };
    }
    return evidence;
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
      evidence.pull.checks !== "passing" ||
      evidence.blocked ||
      evidence.lease?.installation !== here ||
      evidence.ownerOnly.touched.length > 0
    ) {
      throw new Error(
        "Factory needs a current checked pull request head before opening the Reviewer.",
      );
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
      const opened = await runners.open(await runnerInput("lead"));
      if ("parked" in opened) return false;
      target = opened;
    }
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
      evidence.pull.checks === "passing" &&
      !evidence.ownerOnly.touched.length &&
      evidence.verdict?.approved,
    );
  }

  const operationInput: OperationRuntimeInput = {
    ...options.operations,
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
      if (
        !pull ||
        pull.head !== evidence.pull.headSha ||
        !(await securityReady(pull.head, pull.files)) ||
        !(await issueGatesReady(pull.head))
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
      async applyDecision(decision, id) {
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

  async function factsForDispatcher(): Promise<LeanGitHubFacts> {
    const facts = await adapter.readFacts([issue]);
    const merged = await recoverMerged(facts);
    const waiting = await pendingOwnerDecision();
    const ours = facts.issues.filter((entry) => entry.number === issue);
    return { ...facts, issues: merged || waiting ? [] : ours };
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
  ): Promise<void> {
    if (action.role === "foreman-op") {
      await routeAcceptance();
      return;
    }
    const opened = await runners.open(await runnerInput(action.role));
    if (!("parked" in opened)) return;
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
          wake();
        }
        return;
      }
      case "open-runner":
        await openRunner(action);
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
    if ("issue" in action && action.issue !== null) requireIssue(action.issue);
    switch (action.kind) {
      case "renew-lease":
        if (await holds("intake")) await saveLease(await adapter.lease.renew(issue));
        return;
      case "release-lease":
        if (await holds("intake")) await release(action.why);
        return;
      case "park":
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
    if (!options.reviewObjects || !pull || pull.checks !== "passing") return false;
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

  async function captureReview(runner: RunnerRecord): Promise<void> {
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
    if (provenance.mode === "same-account") {
      if ((await options.allowSameAccount?.()) !== true) {
        await reportOwner(
          "review-account",
          "The project needs another eligible Reviewer account or an explicit same-account review policy.",
        );
        return;
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
    }
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
    const live = options.runner.agentManager.getAgent(runner.agentId);
    const runnerStatus =
      statuses.get(runner.agentId) ?? (live ? runnerStatusFromAgent(live) : undefined);
    if (runnerStatus?.kind === "idle") {
      if (runner.role === "foreman-op") await operations.onRunnerIdle(runner);
      if (runner.role === "reviewer") await captureReview(runner);
    }
    if (runnerStatus?.kind === "quota" && (runner.role === "reviewer" || runner.role === "lead")) {
      await runners.recover(runner, runnerStatus, await runnerInput(runner.role));
    }
    if (runnerStatus?.kind === "detached") await runners.reattach([runner]);
  }

  async function liveRunners(): Promise<RunnerRecord[]> {
    const data = await ledger();
    return Object.values(data.runners).filter(
      (entry) => entry.issue === issue && entry.closedAt === null && entry.serverId === null,
    );
  }

  async function maintainLease(facts: LeanGitHubFacts): Promise<void> {
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
    const facts = await adapter.readFacts([issue]);
    const merged = await recoverMerged(facts);
    if (!merged) await maintainLease(facts);
    // The local adapter reattaches only the issue's daemon-created sessions.
    const result = await runners.reattach(await liveRunners());
    for (const runner of result.gone) {
      await runners.close(runner, "The saved runner is gone.");
    }
    wake();
  }

  async function reconcile(): Promise<void> {
    if (stopped) return;
    const facts = await adapter.readFacts([issue]);
    if (await recoverMerged(facts)) {
      if ((await ledger()).runtimeMerges?.[issue]?.settled) await finishRunners();
      return;
    }
    await maintainLease(facts);
    for (const runner of await liveRunners()) await processRunner(runner);
    if (await mergeRebasedHead(facts)) return;
    await reconciler.reconcile();
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
                deadline: null,
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
    inspectDeadlines: operations.tickWatchdog,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async stop(reason) {
      for (const runner of await liveRunners()) {
        const result = await runners.close(runner, "Factory is pausing this issue.");
        if ("refused" in result) throw new Error(result.refused);
      }
      if ((await ledger()).leases[issue] && (await holds("intake"))) {
        await release(reason === "switch" ? "disable" : reason);
      }
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
      return (await ledger()).runtimeMerges?.[issue]?.settled === true;
    },
  };
}

export type LeanProjectOptions = Omit<LeanRuntimeOptions, "issue">;

function trackedIssues(data: RuntimeLedger): number[] {
  const tracked = new Set<number>();
  for (const lease of Object.values(data.leases)) if (!lease.released) tracked.add(lease.issue);
  for (const intent of Object.values(data.mergeIntents ?? {})) tracked.add(intent.issue);
  for (const number of Object.keys(data.runtimeClaims ?? {})) tracked.add(Number(number));
  for (const runner of Object.values(data.runners)) {
    if (runner.issue !== null && runner.closedAt === null) tracked.add(runner.issue);
  }
  return [...tracked].filter(
    (number) =>
      Number.isSafeInteger(number) && number > 0 && !data.runtimeMerges?.[number]?.settled,
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
  return [...new Set([...tracked, ...ready])].filter(
    (number) => !data.runtimeMerges?.[number]?.settled,
  );
}

type Operations = ReturnType<typeof createOperationRuntime>;

export interface LeanOperationGroup {
  rpc: Operations["runtime"];
  bind(issue: number, input: OperationRuntimeInput): Operations;
  unbind(issue: number): void;
  tickWatchdog(): Promise<void>;
}

/** One operational sidecar and question registry per project. Its sessions are keyed by issue. */
export function createLeanOperationGroup(options: LeanProjectOptions): LeanOperationGroup {
  const inputs = new Map<number, OperationRuntimeInput>();
  const advancing = new Set<number>();
  const { projectId, state, here, now } = options;

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
      const owner = input.issue === null ? inputs.values().next().value : inputs.get(input.issue);
      if (!owner) return { parked: { kind: "capacity" } };
      return owner.runners.open(input);
    },
    async prompt(runner, text) {
      return (await runnerPort(runner)).prompt(runner, text);
    },
    async lastReply(runner) {
      return (await runnerPort(runner)).lastReply(runner);
    },
    async close(runner, reason) {
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
    const epoch = await options.laneEpoch("intake");
    return epoch !== null && options.fenceLane("intake", epoch);
  }

  const operations = createOperationRuntime({
    ...options.operations,
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
      applyDecision(decision, id) {
        if ("issue" in decision) return binding(decision.issue).actions.applyDecision(decision, id);
        return options.operationActions.applyDecision(decision, id);
      },
      postSendBack(input) {
        return binding(input.issue).actions.postSendBack(input);
      },
      sendBackToBuilder(input) {
        return binding(input.issue).actions.sendBackToBuilder(input);
      },
    },
  });

  return {
    rpc: operations.runtime,
    tickWatchdog: operations.tickWatchdog,
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
