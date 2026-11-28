import {
  isAccountBound,
  rankAccounts,
  type FactoryAccounts,
  type UsageList,
} from "../project/account-choice.js";
import type {
  AccountChoice,
  AccountTable,
  LeanStateStore,
  RunnerRef,
  RunnerRole,
} from "./types.js";
import type {
  WorkerAccountCandidate,
  WorkerAccountPick,
} from "../../agent/account-pool/worker-account.js";
import type { RunnerAccountPolicy } from "./account-policy.js";
export type { RunnerAccountPolicy } from "./account-policy.js";

const UNKNOWN_RESET_MS = 60 * 60 * 1000;

interface RoleAccounts {
  providerType: string;
  profileId: string | null;
  /** Null uses all ready accounts of this provider type. An empty list admits none. */
  allowedDefinitions: readonly string[] | null;
}

export type Reason =
  | "selected"
  | "qualifies"
  | "lower-headroom"
  | "builder-account"
  | "not-allowed"
  | "wrong-provider"
  | "profile-bound"
  | "unavailable-on-destination"
  | "parked"
  | "avoided"
  | "unknown"
  | "stale"
  | "exhausted"
  | "below-floor"
  | "pool-excluded"
  | "capacity-reached"
  | "policy-unresolved";

interface CandidateEvidence {
  account: string;
  accountDefinition: string | null;
  reason: Reason;
  evidence?: Candidate["evidence"];
}

interface ReviewDecision {
  builderAgentId: string;
  builderAccount: string;
  builderAccountDefinition: string;
  reviewerAccount: string;
  reviewerAccountDefinition: string;
  mode: "different-account" | "same-account";
  candidates: CandidateEvidence[];
}

export interface ReviewAccountSelection extends ReviewDecision {
  reviewerAgentId: string;
  issue: number;
  headSha: string;
  at: string;
  daemonCreated: true;
  clean: true;
  nonChild: true;
  freshSession: true;
}

export type ReviewBuilder = RunnerRef & { account: string; accountDefinition: string };
export type Choice = AccountChoice & {
  reviewDecision?: ReviewDecision;
  candidates?: CandidateEvidence[];
  accountPolicy?: WorkerAccountPick;
};
export interface Parked {
  parked: Exclude<Awaited<ReturnType<AccountTable["choose"]>>, AccountChoice>["parked"] & {
    accountPolicy?: WorkerAccountPick;
    candidates?: CandidateEvidence[];
    reason?: string;
  };
}
type ChooseInput = Parameters<AccountTable["choose"]>[0];

export interface LeanAccountTable extends AccountTable {
  choose(input: ChooseInput): Promise<Choice | Parked>;
  chooseReviewer(
    input: Omit<ChooseInput, "role">,
    builder: ReviewBuilder,
  ): Promise<Choice | Parked>;
}

export interface Candidate {
  local: string;
  placed: string;
  definition: string | null;
  reason: Reason | null;
  until: number;
  evidence?: WorkerAccountCandidate & { openProjectRunners?: number | null };
}

export interface LeanAccountDependencies {
  projectId: string;
  state: LeanStateStore;
  accounts: FactoryAccounts;
  roleAccounts(role: RunnerRole): Promise<RoleAccounts>;
  /** Resolve local IDs via installation definitions, including aliases of the same account. */
  accountDefinitions(): Promise<ReadonlyMap<string, string>>;
  now(): Date;
  /** Shared worker policy projected onto the accounts authorized for this role. */
  accountPolicy?: RunnerAccountPolicy;
  allowSameAccountReview?(): Promise<boolean>;
}

export function createAccountTable(deps: LeanAccountDependencies): LeanAccountTable {
  async function choose(
    input: ChooseInput,
    builder: ReviewBuilder | null,
  ): Promise<Choice | Parked> {
    const { role, serverId, avoid } = input;
    const policy = await deps.roleAccounts(role);
    const { profileId, providerType } = policy;
    const park = (resetsAt: string | null): Parked => ({ parked: { providerType, resetsAt } });
    const bound = isAccountBound(profileId);
    const boundAccount = profileId && bound ? deps.accounts.profileAccount(profileId) : null;
    if (bound && (serverId || !boundAccount)) return park(null);

    const [ready, definitions, destination, ledger, usage] = await Promise.all([
      deps.accounts.readyProviders(),
      deps.accountDefinitions(),
      serverId ? deps.accounts.destinationAccounts(serverId) : null,
      deps.state.read(deps.projectId),
      deps.accountPolicy ? null : deps.accounts.readUsage(),
    ]);
    const nowMs = deps.now().getTime();
    const candidates = ready.map((local): Candidate => {
      const definition = definitions.get(local) ?? null;
      const placed = destination === null ? local : destination.get(local);
      const readyType = deps.accounts.providerType({ provider: local });
      const parked = definition ? ledger.parkedAccounts[definition] : undefined;
      const until = Date.parse(parked?.until ?? "");
      const reason = candidateExclusion({
        readyType,
        placed,
        definition,
        policy,
        local,
        boundAccount,
        until,
        nowMs,
      });
      return { local, placed: placed ?? local, definition, reason, until };
    });
    applyAvoid(candidates, avoid);
    if (deps.accountPolicy) {
      return deps.accountPolicy({
        projectId: deps.projectId,
        serverId,
        role,
        providerType,
        profileId,
        builder,
        candidates,
        runners: ledger.runners,
        now: () => deps.now(),
        allowSame: deps.allowSameAccountReview,
      });
    }
    if (!usage) throw new Error("Factory account usage is unavailable.");
    const available = candidates.filter((candidate) => candidate.reason === null);
    const rankInput = { candidates: available.map((item) => item.local), usage, nowMs };
    const rank = rankAccounts(rankInput);
    const verdicts = new Map(rank.considered.map((entry) => [entry.provider, entry]));
    for (const candidate of available)
      applyVerdict(candidate, verdicts.get(candidate.local), builder);

    const ranked = available.filter((item) => item.reason === null);
    ranked.sort(
      (left, right) =>
        (verdicts.get(right.local)?.remainingPct ?? 0) -
        (verdicts.get(left.local)?.remainingPct ?? 0),
    );
    const chosen = preferredCandidate(candidates, ranked, builder);
    if (!chosen) return park(earliestReset(candidates, usage, nowMs));
    if (
      builder &&
      chosen.definition === builder.accountDefinition &&
      deps.allowSameAccountReview &&
      !(await deps.allowSameAccountReview())
    )
      return park(null);
    const choice: Choice = {
      account: chosen.placed,
      accountDefinition: chosen.definition,
      providerType,
      profileId,
    };
    if (builder && chosen.definition) {
      choice.reviewDecision = reviewDecision(candidates, chosen, builder, chosen.definition);
    }
    return choice;
  }

  return {
    choose: (input) => choose(input, null),
    chooseReviewer: (input, builder) => choose({ ...input, role: "reviewer" }, builder),
    async park(accountDefinition, providerType, until, reason) {
      const nowMs = deps.now().getTime();
      const resetMs = Date.parse(until ?? "");
      const expiry = resetMs > nowMs ? resetMs : nowMs + UNKNOWN_RESET_MS;
      await deps.state.mutate(deps.projectId, (ledger) => {
        const active = ledger.parkedAccounts[accountDefinition];
        const currentExpiry = active ? Date.parse(active.until) : NaN;
        if (currentExpiry >= expiry || (until === null && currentExpiry > nowMs)) return;
        ledger.parkedAccounts[accountDefinition] = {
          providerType,
          until: new Date(expiry).toISOString(),
          reason,
        };
      });
    },
  };
}

function applyVerdict(
  candidate: Candidate,
  assessment: ReturnType<typeof rankAccounts>["considered"][number] | undefined,
  builder: ReviewBuilder | null,
): void {
  const verdict = assessment?.verdict;
  if (!verdict || verdict === "unknown" || (builder && !candidate.definition)) {
    candidate.reason = "unknown";
  } else if (verdict !== "qualifies") {
    candidate.reason = verdict;
  }
}

function candidateExclusion(input: {
  readyType: string | null;
  placed: string | undefined;
  definition: string | null;
  policy: RoleAccounts;
  local: string;
  boundAccount: string | null;
  until: number;
  nowMs: number;
}): Reason | null {
  const { readyType, placed, definition, policy, local, boundAccount, until, nowMs } = input;
  if (!placed) return "unavailable-on-destination";
  if (boundAccount && local !== boundAccount) return "profile-bound";
  if (
    policy.allowedDefinitions &&
    (!definition || !policy.allowedDefinitions.includes(definition))
  ) {
    return definition ? "not-allowed" : "unknown";
  }
  if (!readyType) return "unknown";
  if (readyType !== policy.providerType) return "wrong-provider";
  return until > nowMs ? "parked" : null;
}

function applyAvoid(candidates: Candidate[], excluded: string[]): void {
  const avoid = new Set(excluded);
  for (const { local, placed, definition } of candidates) {
    if (definition && (avoid.has(local) || avoid.has(placed))) avoid.add(definition);
  }
  for (const candidate of candidates) {
    if (candidate.reason !== null) continue;
    const { local, placed, definition } = candidate;
    if (avoid.has(local) || avoid.has(placed) || (definition && avoid.has(definition))) {
      candidate.reason = "avoided";
    }
  }
}

function preferredCandidate(
  candidates: Candidate[],
  ranked: Candidate[],
  builder: ReviewBuilder | null,
) {
  if (!builder) return ranked[0];
  const other = ranked.find((candidate) => candidate.definition !== builder.accountDefinition);
  if (other) return other;
  const uncertain = candidates.some(
    (candidate) =>
      candidate.definition !== builder.accountDefinition &&
      (candidate.reason === "unknown" || candidate.reason === "stale"),
  );
  return uncertain ? undefined : ranked[0];
}

export function reviewDecision(
  candidates: Candidate[],
  chosen: Candidate,
  builder: ReviewBuilder,
  definition: string,
): ReviewDecision {
  const same = definition === builder.accountDefinition;
  chosen.reason = "selected";
  return {
    builderAgentId: builder.agentId,
    builderAccount: builder.account,
    builderAccountDefinition: builder.accountDefinition,
    reviewerAccount: chosen.placed,
    reviewerAccountDefinition: definition,
    mode: same ? "same-account" : "different-account",
    candidates: candidates.map((candidate) => ({
      account: candidate.placed,
      accountDefinition: candidate.definition,
      ...(candidate.evidence ? { evidence: candidate.evidence } : {}),
      reason:
        candidate.reason ??
        (candidate.definition === builder.accountDefinition ? "builder-account" : "lower-headroom"),
    })),
  };
}

function earliestReset(candidates: Candidate[], usage: UsageList, nowMs: number): string | null {
  let earliest = Infinity;
  for (const candidate of candidates) {
    if (
      (candidate.reason === "parked" || candidate.reason === "below-floor") &&
      candidate.until > nowMs
    )
      earliest = Math.min(earliest, candidate.until);
    if (candidate.reason === "exhausted") {
      earliest = Math.min(earliest, accountReset(usage, candidate.local, nowMs));
    }
  }
  return Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
}

function accountReset(usage: UsageList, local: string, nowMs: number): number {
  const reading = usage.providers.find((entry) => entry.providerId === local);
  const stopped = reading?.windows.filter((window) => (window.remainingPct ?? Infinity) <= 0);
  if (!stopped?.length) return Infinity;
  const resets = stopped.map((window) => Date.parse(window.resetsAt ?? ""));
  return resets.every((reset) => reset > nowMs) ? Math.max(...resets) : Infinity;
}
