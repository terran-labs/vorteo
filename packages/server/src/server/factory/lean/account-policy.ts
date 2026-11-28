import {
  pickWorkerAccount,
  type WorkerAccountCandidate,
  type WorkerAccountInput,
  type WorkerAccountPick,
} from "../../agent/account-pool/worker-account.js";
import { ACCOUNT_READING_MAX_AGE_MS } from "../project/account-choice.js";
import { installationProviderReference } from "@getpaseo/protocol/installation-settings";
import { resolveLaunchHomes } from "../../system-project/launch-selection.js";
import {
  reviewDecision,
  type LeanAccountDependencies,
  type Choice,
  type Parked,
  type Candidate,
  type Reason,
  type ReviewBuilder,
} from "./accounts.js";
import type { LeanLedger, RunnerRole } from "./types.js";

export interface FactoryAccountSelection {
  allowSame?: LeanAccountDependencies["allowSameAccountReview"];
  projectId: string;
  serverId: string | null;
  role: RunnerRole;
  profileId: string | null;
  providerType: string;
  builder: ReviewBuilder | null;
  candidates: readonly Candidate[];
  runners: LeanLedger["runners"];
  now(): Date;
}

/** All provider IDs in this snapshot belong to the requested destination. */
export interface FactoryAccountSnapshot extends Pick<
  WorkerAccountInput,
  | "settings"
  | "ready"
  | "usage"
  | "defaultProvider"
  | "priority"
  | "usageLimitedUntilByProvider"
  | "capacityByProvider"
  | "reservedHeadroomPct"
> {
  serverId: string | null;
  installationDefinitionByProvider: Readonly<Record<string, string>>;
}

interface FactoryAccountAssessment {
  decision: WorkerAccountPick;
  candidates: Candidate[];
}
export type RunnerAccountPolicy = (selection: FactoryAccountSelection) => Promise<Choice | Parked>;

/** The caller reads settings, usage and project capacity for this specific role and host. */
export function createFactoryAccountPolicy(
  readDestination: (selection: FactoryAccountSelection) => Promise<FactoryAccountSnapshot>,
): RunnerAccountPolicy {
  return async (selection) => {
    const snapshot = await readDestination(selection);
    if (snapshot.serverId !== selection.serverId)
      throw new Error("Factory account settings came from a different destination.");
    const authorized = new Map<string, Candidate>();
    for (const candidate of selection.candidates) {
      if (candidate.reason === null) authorized.set(candidate.placed, candidate);
    }
    const definitions = snapshot.installationDefinitionByProvider;
    const definition = (id: string) => (Object.hasOwn(definitions, id) ? definitions[id] : null);
    const builderAliases = Object.keys(definitions).filter(
      (id) => definitions[id] === selection.builder?.accountDefinition,
    );
    if (selection.builder && selection.builder.serverId === selection.serverId)
      builderAliases.push(selection.builder.account);
    const conflicts = await conflictingReviewerBindings(
      snapshot,
      builderAliases,
      selection.builder,
    );
    const admitted = (id: string) => {
      const candidate = authorized.get(id);
      if (!candidate || conflicts.has(id)) return false;
      if ((selection.serverId !== null || selection.builder) && !definition(id)) return false;
      return candidate.definition === definition(id);
    };
    const nowMs = selection.now().getTime();
    const decision = await pickWorkerAccount({
      ...snapshot,
      ready: snapshot.ready.map((entry) => ({
        ...entry,
        enabled: entry.enabled && admitted(entry.provider),
      })),
      providerType: selection.providerType,
      nowMs,
      requireMeasured: selection.role === "reviewer",
      deprioritizeProviders: builderAliases,
      reservedHeadroomPct: selection.role === "delivery" ? 0 : snapshot.reservedHeadroomPct,
    });
    const unavailable = new Set(
      snapshot.ready
        .filter((row) => !row.enabled || row.status !== "ready")
        .map((row) => row.provider),
    );
    const candidates = rankedCandidates(selection.candidates, decision, admitted, unavailable);
    for (const candidate of candidates) {
      if (candidate.evidence)
        candidate.evidence = {
          ...candidate.evidence,
          openProjectRunners: openProjectRunners(selection, candidate, definition),
        };
    }
    return policyChoice({ decision, candidates }, selection, nowMs);
  };
}

/** An alias labelled with a different definition cannot establish independent review. */
async function conflictingReviewerBindings(
  snapshot: FactoryAccountSnapshot,
  aliases: string[],
  builder: ReviewBuilder | null,
) {
  const conflicts = new Set<string>();
  if (!builder || aliases.length === 0) return conflicts;
  const homes = await resolveLaunchHomes(snapshot.ready, snapshot.settings, undefined, aliases);
  const builderHomes = new Set(aliases.flatMap((id) => homes.get(id) ?? []));
  const reference = (id: string) => installationProviderReference(id, snapshot.settings.providers);
  const builderRefs = new Set(aliases.map(reference));
  for (const { provider } of snapshot.ready) {
    if (snapshot.installationDefinitionByProvider[provider] === builder.accountDefinition) continue;
    const home = homes.get(provider);
    if ((home && builderHomes.has(home)) || builderRefs.has(reference(provider)))
      conflicts.add(provider);
  }
  return conflicts;
}

/** A legacy runner without a resolvable account makes the affected count unknown. */
function openProjectRunners(
  selection: FactoryAccountSelection,
  candidate: Candidate,
  definition: (id: string) => string | null,
): number | null {
  let count = 0;
  for (const runner of Object.values(selection.runners)) {
    if (runner.closedAt !== null || runner.serverId !== selection.serverId) continue;
    const actual = runner.accountDefinition ?? (runner.account && definition(runner.account));
    if (actual && candidate.definition) {
      if (actual === candidate.definition) count++;
    } else if (runner.account === candidate.placed) {
      count++;
    } else if (!runner.account || !actual) {
      return null;
    }
  }
  return count;
}

function rankedCandidates(
  candidates: readonly Candidate[],
  decision: WorkerAccountPick,
  admitted: (id: string) => boolean,
  unavailable: ReadonlySet<string>,
): Candidate[] {
  const byProvider = new Map<string, Candidate[]>();
  const pending = new Set(candidates);
  for (const row of candidates) {
    if (row.reason === "unavailable-on-destination") continue;
    const group = byProvider.get(row.placed) ?? [];
    group.push(row);
    byProvider.set(row.placed, group);
  }
  const ranked: Candidate[] = [];
  for (const evidence of decision.candidates) {
    const group = byProvider.get(evidence.provider);
    if (!group) {
      ranked.push({
        local: evidence.provider,
        placed: evidence.provider,
        definition: evidence.installationDefinitionId,
        reason: "not-allowed",
        until: NaN,
        evidence,
      });
      continue;
    }
    for (const row of group) {
      pending.delete(row);
      const verified = row.definition === evidence.installationDefinitionId && admitted(row.placed);
      const reason =
        row.reason ??
        (verified || unavailable.has(row.placed) ? factoryReason(evidence) : "unknown");
      ranked.push({
        ...row,
        reason,
        until: row.reason ? row.until : Date.parse(evidence.earliestResetAt ?? ""),
        evidence,
      });
    }
  }
  for (const row of pending)
    ranked.push({ ...row, reason: row.reason ?? "unavailable-on-destination" });
  return ranked;
}

function factoryReason(candidate: WorkerAccountCandidate): Reason | null {
  switch (candidate.exclusionReason) {
    case null:
      return null;
    case "measurement-required":
      return candidate.readingAgeMs !== null && candidate.readingAgeMs > ACCOUNT_READING_MAX_AGE_MS
        ? "stale"
        : "unknown";
    case "usage-limit-hold":
      return "parked";
    case "quota-below-floor":
      return candidate.remainingPct === 0 ? "exhausted" : "below-floor";
    case "wrong-provider-type":
      return "wrong-provider";
    case "avoided":
      return "avoided";
    case "automatic-opt-out":
    case "outside-pool":
      return "pool-excluded";
    case "invalid-capacity":
    case "invalid-reservation":
    case "quota-policy-unresolved":
      return "policy-unresolved";
    case "capacity-reached":
      return "capacity-reached";
    case "not-ready":
    case "disabled":
    case "signed-out":
      return "unavailable-on-destination";
  }
}

async function policyChoice(
  { decision, candidates }: FactoryAccountAssessment,
  { providerType, profileId, builder, allowSame }: FactoryAccountSelection,
  nowMs: number,
): Promise<Choice | Parked> {
  const selected = candidates.find(
    (row) => row.reason === null && row.placed === decision.provider,
  );
  const same = builder && selected?.definition === builder.accountDefinition;
  const uncertain =
    same &&
    candidates.some(
      (row) =>
        row.definition !== builder.accountDefinition &&
        (row.reason === "unknown" || row.reason === "stale" || row.reason === "policy-unresolved"),
    );
  let parkReason: string | null = null;
  if (!selected) parkReason = decision.reason;
  else if (uncertain) parkReason = "unverified-alternate";
  else if (same && !(await allowSame?.())) parkReason = "same-account-disallowed";
  if (!selected || parkReason) {
    const resets = candidates
      .filter((row) => row.reason === "parked" && row.until > nowMs)
      .map((row) => row.until);
    const policyReset = Date.parse(decision.earliestResetAt ?? "");
    if (policyReset > nowMs) resets.push(policyReset);
    return {
      parked: {
        providerType,
        reason: parkReason ?? decision.reason,
        resetsAt: resets.length ? new Date(Math.min(...resets)).toISOString() : null,
        accountPolicy: decision,
        candidates: candidateEvidence(candidates, null),
      },
    };
  }
  const choice: Choice = {
    candidates: candidateEvidence(candidates, selected),
    account: selected.placed,
    accountDefinition: selected.definition,
    providerType,
    profileId,
    accountPolicy: decision,
  };
  if (builder && selected.definition)
    choice.reviewDecision = reviewDecision(candidates, selected, builder, selected.definition);
  return choice;
}

function candidateEvidence(rows: Candidate[], selected: Candidate | null) {
  return rows.map((row) => ({
    account: row.placed,
    accountDefinition: row.definition,
    reason: row === selected ? ("selected" as const) : (row.reason ?? ("qualifies" as const)),
    evidence: row.evidence,
  }));
}
