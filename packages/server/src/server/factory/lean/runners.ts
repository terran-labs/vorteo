import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { AgentUsage } from "../../agent/agent-sdk-types.js";
import type { LeanAccountTable, ReviewAccountSelection, ReviewBuilder } from "./accounts.js";
import { foremanCharter } from "./charters/foreman.js";
import { leadCharter } from "./charters/lead.js";
import { mechanicCharter } from "./charters/mechanic.js";
import { reviewerCharter } from "./charters/reviewer.js";
import type { ForeignReviewLaunchEvidence, ForeignReviewOpenEvidence } from "./review-evidence.js";
import type {
  AccountChoice,
  AccountTable,
  LeanLedger,
  LeanStateStore,
  ParkReason,
  RunnerOpenInput,
  RunnerPort,
  RunnerRef,
  RunnerStatus,
} from "./types.js";

export interface BoundRunnerOpenInput extends RunnerOpenInput {
  foreignReview?: ForeignReviewOpenEvidence;
}

export type RunnerRecord = LeanLedger["runners"][string] & {
  installation?: string;
  reviewAccountSelection?: ReviewAccountSelection;
  foreignReviewLaunch?: ForeignReviewLaunchEvidence;
  runMetrics?: RunnerMetrics;
  quotaRecoveryPending?: true;
};
type Record = RunnerRecord;

export interface RunnerMetrics {
  elapsedMs: number;
  providerType: string | null;
  account: string | null;
  accountDefinition: string | null;
  /** Provider's last recorded usage for the session. Its accounting rules define the totals. */
  usage: AgentUsage | null;
}
type Destination = Pick<RunnerRef, "serverId" | "agentId">;
type Open = Awaited<ReturnType<RunnerPort["open"]>>;
type QuotaStop = Extract<RunnerStatus, { kind: "quota" }>;

interface Launch {
  input: BoundRunnerOpenInput;
  identity?: LaunchIdentity;
  serverId: string | null;
  worktree: RunnerOpenInput["worktree"];
  choice: AccountChoice;
  labels: { [key: string]: string };
  systemPrompt: string;
  initialPrompt: string;
}

interface LaunchIdentity {
  agentId: string;
  seal(workspaceId: string, review?: ReviewLaunch): Promise<void>;
}

export interface PendingRunnerLaunch {
  runner: RunnerRef & { installation?: string };
  issue: number | null;
  workspaceId: string | null;
  choice: SelectedChoice;
  review?: ReviewLaunch;
}

interface LaunchLedger extends LeanLedger {
  pendingRunnerLaunches?: { [agentId: string]: PendingRunnerLaunch };
}

interface ReviewLaunch {
  headSha: string;
  daemonCreated: true;
  clean: true;
  nonChild: true;
  freshSession: true;
}

type LaunchResult =
  | { agentId: string; review?: ReviewLaunch }
  | { quota: { resetsAt: string | null } };
type LaunchChoice = Awaited<ReturnType<LeanAccountTable["chooseReviewer"]>>;
type SelectedChoice = Exclude<LaunchChoice, { parked: unknown }>;
type Placement = { serverId: string | null } | { parked: ParkReason };
type Recovery = Open | { refused: string };

export interface RunnerDependencies {
  projectId: string;
  installation: string;
  state: LeanStateStore;
  accounts: AccountTable &
    Partial<Pick<LeanAccountTable, "chooseReviewer" | "chooseForeignReviewer">>;
  now(): Date;
  /** Owns capacity and connected-host availability. Worktree placement is mandatory when set. */
  place(input: RunnerOpenInput): Promise<Placement>;
  /** Bind the destination, worktree, provider and profile before launching the first turn. */
  createAgent(launch: Launch): Promise<LaunchResult>;
  /** Attach with replay. Null means missing or archived, never a temporary disconnect. */
  subscribe(
    target: Destination,
    listener: (status: RunnerStatus) => void,
  ): Promise<(() => void) | null>;
  prompt: RunnerPort["prompt"];
  lastReply: RunnerPort["lastReply"];
  /** Idempotent for already archived agents. Must preserve the workspace and worktree. */
  archiveAgent(target: Destination): Promise<void>;
  readUsage?(target: Destination): Promise<AgentUsage | null>;
  discoverAgent?(
    launch: PendingRunnerLaunch,
  ): Promise<"missing" | "adopt" | "close" | "unverified">;
  recoveryIssue?: number;
  /** Null means verified pushed. Return a refusal if verification fails or cannot be performed. */
  checkLeadBranch(runner: RunnerRef, issue: number): Promise<string | null>;
  verifyQuotaRecovery?(runner: RunnerRef, issue: number | null): Promise<string | null>;
  deliveryCharter?: string;
}

export interface LeanRunnerPort extends RunnerPort {
  dispose(): void;
  /** The caller supplies a continuation brief from the claim branch, plan and saved progress. */
  recover(runner: RunnerRef, status: QuotaStop, input: BoundRunnerOpenInput): Promise<Recovery>;
}

/** Local adapter classification. Read the same structured hold on replay after a restart. */
export function runnerStatusFromAgent(agent: ManagedAgent): RunnerStatus {
  const hold = agent.config.usageLimitHold;
  if (hold && !hold.releasedAt) {
    return { kind: "quota", accountDefinition: null, resetsAt: hold.resetsAt ?? null };
  }
  if (agent.pendingPermissions.size > 0) {
    return { kind: "permission", detail: "The runner needs a permission decision to continue." };
  }
  switch (agent.lifecycle) {
    case "initializing":
    case "running":
      return { kind: "running" };
    case "idle":
      return { kind: "idle" };
    case "error":
      return { kind: "error", detail: agent.lastError };
    case "closed":
      return { kind: "detached" };
  }
}

export function createRunnerPort(deps: RunnerDependencies): LeanRunnerPort {
  const charters = {
    lead: leadCharter,
    reviewer: reviewerCharter,
    "foreman-op": foremanCharter,
    mechanic: mechanicCharter,
    delivery: deps.deliveryCharter,
  };
  const listeners = new Set<Parameters<RunnerPort["onStatus"]>[0]>();
  const subscriptions = new Map<string, () => void>();
  let tail = Promise.resolve();

  // Capacity, attempt numbering and lifecycle transitions share one project queue.
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(action);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function publish(runner: RunnerRef, status: RunnerStatus): void {
    for (const listener of listeners) listener(runner, status);
  }

  function detach(agentId: string): void {
    const unsubscribe = subscriptions.get(agentId);
    subscriptions.delete(agentId);
    unsubscribe?.();
  }

  async function attach(runner: RunnerRef): Promise<boolean> {
    detach(runner.agentId);
    let detached = false;
    const unsubscribe = await deps.subscribe(runner, (status) => {
      if (detached) return;
      if (status.kind === "detached") {
        detached = true;
        detach(runner.agentId);
      }
      if (status.kind === "quota") {
        publish(runner, { ...status, accountDefinition: runner.accountDefinition });
      } else {
        publish(runner, status);
      }
    });
    if (detached) unsubscribe?.();
    else if (unsubscribe) subscriptions.set(runner.agentId, unsubscribe);
    return unsubscribe !== null;
  }

  function latest(records: LeanLedger["runners"], input: RunnerOpenInput): Record | undefined {
    return Object.values(records)
      .filter((entry) => entry.role === input.role && entry.issue === input.issue)
      .sort((left, right) => right.attempt - left.attempt)[0];
  }

  async function open(input: BoundRunnerOpenInput): Promise<Open> {
    if (input.projectId !== deps.projectId)
      throw new Error("Runner belongs to a different project.");
    await reconcileLaunches(input.issue);
    const ledger = await deps.state.read(deps.projectId);
    const previous = latest(ledger.runners, input);
    if (previous && previous.closedAt === null) {
      if (matchesRunnerReview(previous, input)) return runnerRef(previous);
      await closeRecord(previous, "The review target changed.");
    }

    const systemPrompt = charters[input.role];
    if (!systemPrompt)
      throw new Error("Configure the delivery charter before opening a delivery runner.");
    const where = await deps.place(input);
    if ("parked" in where) return where;
    if (input.worktree && input.worktree.serverId !== where.serverId) {
      return {
        parked: {
          kind: "dev-unavailable",
          reason: "The destination with the saved worktree is unavailable.",
        },
      };
    }

    const builder = reviewBuilder(input, ledger.runners);
    const launch = await launchOnAvailableAccount({
      input,
      serverId: where.serverId,
      systemPrompt,
      builder,
      attempt: (previous?.attempt ?? 0) + 1,
    });
    if ("parked" in launch) return launch;
    const { agentId, choice } = launch;
    const runner = {
      agentId,
      serverId: where.serverId,
      role: input.role,
      account: choice.account,
      accountDefinition: choice.accountDefinition,
      providerType: choice.providerType,
      installation: deps.installation,
      openedAt: deps.now().toISOString(),
      attempt: (previous?.attempt ?? 0) + 1,
    };
    await recordOpen(runner, input.issue, launch);
    if (!(await attach(runner))) publish(runner, { kind: "detached" });
    return runner;
  }

  async function launchOnAvailableAccount(options: {
    input: BoundRunnerOpenInput;
    serverId: string | null;
    systemPrompt: string;
    builder: ReviewBuilder | null;
    attempt: number;
  }): Promise<
    { agentId: string; choice: SelectedChoice; review?: ReviewLaunch } | { parked: ParkReason }
  > {
    const { input, serverId, systemPrompt, builder } = options;
    const avoid = withoutBuilder(input.avoidAccounts ?? [], builder);
    const rejectedAccounts = new Set<string>();
    const rejectedResets: string[] = [];
    function choose(): Promise<LaunchChoice> {
      if (input.foreignReview) {
        if (
          input.role !== "reviewer" ||
          input.issue === null ||
          !deps.accounts.chooseForeignReviewer
        )
          throw new Error("The Factory cannot open a foreign Reviewer for this job.");
        return deps.accounts.chooseForeignReviewer({ serverId, avoid }, input.foreignReview);
      }
      return builder && deps.accounts.chooseReviewer
        ? deps.accounts.chooseReviewer({ serverId, avoid }, builder)
        : deps.accounts.choose({ role: input.role, serverId, avoid });
    }
    for (;;) {
      const choice = await choose();
      if ("parked" in choice) {
        const resets = [...rejectedResets, choice.parked.resetsAt].filter(
          (value): value is string => value !== null,
        );
        return { parked: { kind: "quota", ...choice.parked, resetsAt: resets.sort()[0] ?? null } };
      }
      const identity = deps.discoverAgent
        ? await reserveLaunch(input, serverId, choice, options.attempt)
        : undefined;
      const launch = await deps.createAgent({
        input,
        identity,
        serverId,
        worktree: input.worktree,
        choice,
        labels: {
          "factory.role": input.role,
          "factory.installation": deps.installation,
          ...(input.issue === null ? {} : { "factory.issue": String(input.issue) }),
          ...(choice.account === null ? {} : { "factory.account": choice.account }),
        },
        systemPrompt,
        initialPrompt: input.brief,
      });
      if ("quota" in launch) {
        if (identity) await forgetLaunch(identity.agentId);
        const rejected = choice.accountDefinition ?? choice.account;
        const reset = Date.parse(launch.quota.resetsAt ?? "");
        if (reset > deps.now().getTime()) rejectedResets.push(new Date(reset).toISOString());
        if (!rejected || rejectedAccounts.has(rejected)) {
          return {
            parked: {
              kind: "quota",
              providerType: choice.providerType,
              resetsAt: launch.quota.resetsAt,
            },
          };
        }
        rejectedAccounts.add(rejected);
        if (choice.accountDefinition) {
          await deps.accounts.park(
            choice.accountDefinition,
            choice.providerType,
            launch.quota.resetsAt,
            "The provider refused to start this runner because its usage limit was reached.",
          );
        }
        if (!choice.accountDefinition) avoid.push(rejected);
        continue;
      }

      if (identity && identity.agentId !== launch.agentId) {
        throw new Error("Factory launch returned an agent outside its durable intent.");
      }
      return { ...launch, choice };
    }
  }

  async function recordOpen(
    runner: PendingRunnerLaunch["runner"],
    issue: number | null,
    launch: { choice: SelectedChoice; review?: ReviewLaunch },
  ): Promise<void> {
    try {
      const decision = launch.choice.reviewDecision;
      const foreign = launch.choice.foreignReviewDecision;
      let record: Record = { ...runner, issue, closedAt: null, closeReason: null };
      if (decision) {
        if (issue === null || !launch.review) {
          throw new Error("The reviewer launch could not prove its independent session.");
        }
        record = {
          ...record,
          reviewAccountSelection: {
            ...decision,
            ...launch.review,
            reviewerAgentId: runner.agentId,
            issue,
            at: runner.openedAt,
          },
        };
      }
      if (foreign) {
        const { binding, ...selection } = foreign;
        if (issue === null || launch.review?.headSha !== binding.submission.head) {
          throw new Error("The reviewer launch did not match the verified pull request.");
        }
        record.foreignReviewLaunch = {
          ...selection,
          ...launch.review,
          claimGeneration: binding.submission.generation,
          ...(binding.hostProof && { hostProof: binding.hostProof }),
          reviewerAgentId: runner.agentId,
          issue,
          at: runner.openedAt,
        };
      }
      await deps.state.mutate(deps.projectId, (state: LaunchLedger) => {
        state.runners[runner.agentId] = record;
        if (state.pendingRunnerLaunches) delete state.pendingRunnerLaunches[runner.agentId];
      });
    } catch (error) {
      if (deps.discoverAgent) throw error;
      const failure = await deps.archiveAgent(runner).then(
        () => error,
        (cleanupError: unknown) =>
          new AggregateError(
            [error, cleanupError],
            "The runner could not be recorded or archived.",
          ),
      );
      throw failure;
    }
  }

  async function reserveLaunch(
    input: RunnerOpenInput,
    serverId: string | null,
    choice: SelectedChoice,
    attempt: number,
  ): Promise<LaunchIdentity> {
    const agentId = await deps.state.mutate(deps.projectId, (state: LaunchLedger) => {
      const id = launchAgentId(deps.installation, deps.projectId, state.revision, input);
      const runner: PendingRunnerLaunch["runner"] = {
        agentId: id,
        serverId,
        role: input.role,
        account: choice.account,
        accountDefinition: choice.accountDefinition,
        providerType: choice.providerType,
        installation: deps.installation,
        attempt,
        openedAt: deps.now().toISOString(),
      };
      state.pendingRunnerLaunches ??= {};
      state.pendingRunnerLaunches[id] = { runner, issue: input.issue, choice, workspaceId: null };
      return id;
    });
    return {
      agentId,
      async seal(workspaceId, review) {
        await deps.state.mutate(deps.projectId, (state: LaunchLedger) => {
          const intent = state.pendingRunnerLaunches?.[agentId];
          if (!intent || intent.workspaceId !== null)
            throw new Error("Factory launch lost its reservation.");
          intent.workspaceId = workspaceId;
          if (review) intent.review = review;
        });
      },
    };
  }

  async function forgetLaunch(agentId: string): Promise<void> {
    await deps.state.mutate(deps.projectId, (state: LaunchLedger) => {
      if (state.pendingRunnerLaunches) delete state.pendingRunnerLaunches[agentId];
    });
  }

  async function reconcileLaunches(issue: number | null | undefined): Promise<void> {
    if (!deps.discoverAgent) return;
    const ledger: LaunchLedger = await deps.state.read(deps.projectId);
    for (const intent of Object.values(ledger.pendingRunnerLaunches ?? {})) {
      if (issue !== undefined && intent.issue !== issue) continue;
      const found = await deps.discoverAgent(intent);
      if (found === "unverified") {
        throw new Error(
          "Factory found an agent that could not be matched to its saved launch intent.",
        );
      }
      if (found === "adopt") {
        await recordOpen(intent.runner, intent.issue, intent);
        if (!(await attach(intent.runner))) publish(intent.runner, { kind: "detached" });
      } else {
        if (found === "close") await deps.archiveAgent(intent.runner);
        await forgetLaunch(intent.runner.agentId);
      }
    }
  }

  function reviewBuilder(
    input: BoundRunnerOpenInput,
    records: LeanLedger["runners"],
  ): ReviewBuilder | null {
    if (input.role !== "reviewer" || input.foreignReview || !deps.accounts.chooseReviewer)
      return null;
    const lead = latest(records, { ...input, role: "lead" });
    if (!lead?.account || !lead.accountDefinition) {
      throw new Error("The Factory cannot verify the account of the lead for this review.");
    }
    return { ...runnerRef(lead), account: lead.account, accountDefinition: lead.accountDefinition };
  }

  async function closeRecord(
    record: Record,
    why: string,
    quota = false,
  ): ReturnType<RunnerPort["close"]> {
    if (record.closedAt !== null) return { closed: true };
    const runner = runnerRef(record);
    if (record.quotaRecoveryPending) {
      return archiveAndRecord(record, why);
    }
    if (quota && deps.verifyQuotaRecovery) {
      const refusal = await deps.verifyQuotaRecovery(runner, record.issue);
      if (refusal !== null) return { refused: refusal };
      await deps.state.mutate(deps.projectId, (state) => {
        const current: Record | undefined = state.runners[runner.agentId];
        if (current) current.quotaRecoveryPending = true;
      });
    } else if (record.role === "lead" && record.issue !== null) {
      const refusal = await deps.checkLeadBranch(runner, record.issue);
      if (refusal !== null) return { refused: refusal };
    }
    return archiveAndRecord(record, why);
  }

  async function archiveAndRecord(record: Record, why: string): Promise<{ closed: true }> {
    const runner = runnerRef(record);
    const usage = deps.readUsage ? await deps.readUsage(runner) : null;
    await deps.archiveAgent(runner);
    detach(runner.agentId);
    await deps.state.mutate(deps.projectId, (state) => {
      const current: Record | undefined = state.runners[runner.agentId];
      if (current && current.closedAt === null) {
        const finished = deps.now();
        current.closedAt = finished.toISOString();
        current.closeReason = why;
        delete current.quotaRecoveryPending;
        current.runMetrics = {
          elapsedMs: Math.max(0, finished.getTime() - Date.parse(current.openedAt)),
          providerType: current.providerType,
          account: current.account,
          accountDefinition: current.accountDefinition,
          usage,
        };
      }
    });
    return { closed: true };
  }

  async function finishQuotaReplacements(ledger: LeanLedger): Promise<void> {
    for (const raw of Object.values(ledger.runners)) {
      const record: Record = raw;
      if (deps.recoveryIssue !== undefined && record.issue !== deps.recoveryIssue) continue;
      if (record.quotaRecoveryPending && record.closedAt === null) {
        await archiveAndRecord(record, "The runner reached its provider usage limit.");
      }
    }
  }

  return {
    dispose() {
      for (const agentId of subscriptions.keys()) detach(agentId);
      listeners.clear();
    },
    open: (input) => serialize(() => open(input)),
    async prompt(runner, text) {
      const ledger = await deps.state.read(deps.projectId);
      const record = ledger.runners[runner.agentId];
      if (!record || record.closedAt !== null) return "gone";
      return deps.prompt(runnerRef(record), text);
    },
    close(runner, why) {
      return serialize(async () => {
        const ledger = await deps.state.read(deps.projectId);
        const record = ledger.runners[runner.agentId];
        if (!record) return { refused: "The project has no record of this runner." };
        return closeRecord(record, why);
      });
    },
    reattach(runners) {
      return serialize(async () => {
        await reconcileLaunches(deps.recoveryIssue);
        await finishQuotaReplacements(await deps.state.read(deps.projectId));
        const ledger = await deps.state.read(deps.projectId);
        const attached: RunnerRef[] = [];
        const gone: RunnerRef[] = [];
        for (const runner of runners) {
          const record = ledger.runners[runner.agentId];
          if (!record || record.closedAt !== null) {
            gone.push(runner);
            continue;
          }
          const saved = runnerRef(record);
          if (await attach(saved)) attached.push(saved);
          else gone.push(saved);
        }
        return { attached, gone };
      });
    },
    async lastReply(runner) {
      const ledger = await deps.state.read(deps.projectId);
      const record = ledger.runners[runner.agentId];
      return record ? deps.lastReply(runnerRef(record)) : null;
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover(runner, status, input) {
      return serialize(async () => {
        const ledger = await deps.state.read(deps.projectId);
        const record = ledger.runners[runner.agentId];
        if (
          !record ||
          record.issue !== input.issue ||
          record.role !== input.role ||
          input.projectId !== deps.projectId
        ) {
          return {
            refused: "The replacement does not match the saved runner's project, issue and role.",
          };
        }
        const previous = latest(ledger.runners, input);
        if (previous?.agentId !== record.agentId) {
          if (previous && previous.closedAt === null) return runnerRef(previous);
          return { refused: "A newer runner already took this job." };
        }
        const { accountDefinition, providerType } = record;
        if (record.closedAt === null && accountDefinition && providerType) {
          await deps.accounts.park(
            accountDefinition,
            providerType,
            status.resetsAt,
            "The runner reached its provider usage limit.",
          );
        }
        const closed = await closeRecord(
          record,
          "The runner reached its provider usage limit.",
          true,
        );
        if ("refused" in closed) return closed;
        // Without a stable definition, keep this destination's local binding out of this retry.
        const avoid = [...(input.avoidAccounts ?? [])];
        if (!accountDefinition && record.account) avoid.push(record.account);
        return open({ ...input, avoidAccounts: avoid });
      });
    },
  };
}

function launchAgentId(
  installation: string,
  projectId: string,
  revision: number,
  input: RunnerOpenInput,
): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify([installation, projectId, revision, input.issue, input.role]))
    .digest("hex");
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-5${bytes.slice(13, 16)}-8${bytes.slice(17, 20)}-${bytes.slice(20, 32)}`;
}

function withoutBuilder(avoid: string[], builder: ReviewBuilder | null): string[] {
  return builder
    ? avoid.filter(
        (account) => account !== builder.account && account !== builder.accountDefinition,
      )
    : [...avoid];
}

function runnerRef(record: Record): RunnerRef {
  const {
    issue: _issue,
    closedAt: _closedAt,
    closeReason: _closeReason,
    reviewAccountSelection: _reviewAccountSelection,
    foreignReviewLaunch: _foreignReviewLaunch,
    runMetrics: _runMetrics,
    quotaRecoveryPending: _quotaRecoveryPending,
    ...runner
  } = record;
  return runner;
}

function matchesRunnerReview(record: Record, input: BoundRunnerOpenInput): boolean {
  const binding = input.foreignReview;
  if (!binding) return record.foreignReviewLaunch === undefined;
  const receipt = record.foreignReviewLaunch;
  return (
    receipt?.headSha === binding.submission.head &&
    receipt.claimGeneration === binding.submission.generation &&
    isDeepStrictEqual(receipt.hostProof, binding.hostProof) &&
    record.providerType === binding.policy.providerType
  );
}
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
