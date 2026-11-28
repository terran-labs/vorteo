import type { FactoryActivityEntry } from "@getpaseo/server/factory-lean";
import { plan } from "./dispatcher.js";
import { deriveStages, type IssueLedger } from "./issue-state.js";
import type { MergeIntent } from "./merge-gate.js";
import type { RunnerMetrics } from "./runners.js";
import type { DispatchContext, GitHubFacts, IssueStageKind, Verdict } from "./types.js";

const day = 86_400_000;

export type MetricSource =
  | "turns"
  | "quota"
  | "stalls"
  | "merges"
  | "questions"
  | "claims"
  | "installs"
  | "permissions";
type Coverage = "complete" | "partial" | "unavailable";
type ReviewIndependence =
  | "distinct-account"
  | "different-provider"
  | "verified-fallback"
  | "unverified"
  | "unverified-foreign";
type CoverageFor = (source: MetricSource, samples: number) => Coverage;

interface Observation {
  id: string;
  issue: number | null;
  at: string;
}

type MetricObservation =
  | (Observation & {
      kind: "turn";
      role: "standing-lead" | "standing-mechanic" | "runner";
      origin: "timer" | "event" | "other" | null;
      tokens: number | null;
    })
  | (Observation & { kind: "quota"; beganAt: string; alternateEligible: boolean | null })
  | (Observation & { kind: "stall"; deadline: string; stallStartedAt: string | null })
  | (Observation & {
      kind: "merge";
      headSha: string | null;
      mergeSha: string | null;
      installation: string;
      outcome: "settled" | "inconsistent";
      timeBasis: "github" | "daemon-observed";
    })
  | (Observation & { kind: "claim"; result: "stale" | "conflict" })
  | (Observation & { kind: "install-finding"; jobId: string; result: "defect" | "past-red-check" })
  | (Observation & { kind: "permission-grant"; source: "manual" })
  | (Observation & {
      kind: "review";
      sha: string;
      approved: boolean;
      findings: number | null;
      independence: ReviewIndependence;
    });

interface StageVisit {
  generation: string;
  stage: IssueStageKind;
  since: string;
  until: string | null;
}

export interface LeanMetricLedger extends IssueLedger {
  metricObservations?: Record<string, MetricObservation>;
  metricStages?: Record<string, StageVisit[]>;
  runtimeMerges?: Record<string, { head: string; mergeSha: string; settled: boolean }>;
  mergeIntents?: Record<string, MergeIntent>;
}

export interface LeanMetricWindow {
  from: string;
  until: string;
  /** Set complete only when the caller can attest to full collection in this window. */
  coverage?: Partial<Record<MetricSource, Coverage>>;
}

interface MetricOptions {
  ledger: LeanMetricLedger;
  now: Date;
  window: LeanMetricWindow;
  activity?: readonly FactoryActivityEntry[];
  /** Server identity for runners whose binding is local to this ledger. */
  localMachine?: string;
}

function epoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function elapsed(start: string | null | undefined, end: string | null | undefined): number | null {
  const begin = epoch(start);
  const finish = epoch(end);
  return begin !== null && finish !== null && finish >= begin ? finish - begin : null;
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sample(values: readonly (number | null)[]) {
  const observed = values.filter((value) => value !== null);
  const total = observed.reduce((sum, value) => sum + value, 0);
  return {
    total: observed.length ? total : null,
    observed: observed.length,
    missing: values.length - observed.length,
  };
}

function median(values: readonly (number | null)[]): number | null {
  const observed = values.filter((value) => value !== null).toSorted((a, b) => a - b);
  if (!observed.length) return null;
  const mid = Math.floor(observed.length / 2);
  return observed.length % 2 ? observed[mid] : (observed[mid - 1] + observed[mid]) / 2;
}

export function observeLeanMetric(ledger: LeanMetricLedger, observation: MetricObservation): void {
  if (epoch(observation.at) === null || !observation.id) return;
  const observations = (ledger.metricObservations ??= {});
  observations[observation.id] ??= observation;
}

export function observeLeanStage(
  ledger: LeanMetricLedger,
  issue: number,
  current: Pick<StageVisit, "generation" | "stage"> | null,
  at: string,
): void {
  const stages = (ledger.metricStages ??= {});
  const visits = (stages[issue] ??= []);
  const prior = visits.at(-1);
  if (prior?.until === null) {
    if (prior.generation === current?.generation && prior.stage === current.stage) return;
    if (elapsed(prior.since, at) === null) return;
    prior.until = at;
  }
  if (current && epoch(at) !== null) visits.push({ ...current, since: at, until: null });
}

export function observeLeanReview(
  ledger: LeanMetricLedger,
  input: {
    issue: number;
    verdict: Verdict;
    independence: ReviewIndependence | "same-account-recorded";
    at: string;
  },
): void {
  const { issue, verdict, independence, at } = input;
  if (verdict.source !== "local-runner") return;
  const count = verdict.findings?.match(/^\s*\d+\.\s+\S/gm)?.length ?? 0;
  const findings = count || (verdict.approved && !verdict.findings ? 0 : null);
  observeLeanMetric(ledger, {
    kind: "review",
    id: `review:${issue}:${verdict.sha}:${verdict.reviewer.agentId}`,
    issue,
    at,
    sha: verdict.sha,
    approved: verdict.approved,
    findings,
    independence: independence === "same-account-recorded" ? "verified-fallback" : independence,
  });
}

function runEvidence(ledger: LeanMetricLedger, issue: number, now: Date, localMachine?: string) {
  return Object.values(ledger.runners)
    .filter((entry) => entry.issue === issue)
    .sort((left, right) => left.openedAt.localeCompare(right.openedAt))
    .map((runner: LeanMetricLedger["runners"][string] & { runMetrics?: RunnerMetrics }) => {
      const usage = runner.runMetrics?.usage;
      return {
        role: runner.role,
        machine: runner.serverId ?? localMachine ?? null,
        installationAccount: runner.accountDefinition,
        provider: runner.providerType,
        attempt: runner.attempt,
        openedAt: runner.openedAt,
        closedAt: runner.closedAt,
        elapsedMs: elapsed(runner.openedAt, runner.closedAt ?? now.toISOString()),
        elapsedBasis: runner.closedAt ? ("closed-session" as const) : ("still-open" as const),
        usage: {
          sessionTokens: numberOrNull(usage?.sessionTokens),
          inputTokens: numberOrNull(usage?.inputTokens),
          cachedInputTokens: numberOrNull(usage?.cachedInputTokens),
          outputTokens: numberOrNull(usage?.outputTokens),
          reportedCostUsd: numberOrNull(usage?.totalCostUsd),
          estimatedCostUsd: numberOrNull(usage?.estimatedCostUsd),
        },
      };
    });
}

function pairBoundedQuota(
  entries: readonly Extract<MetricObservation, { kind: "quota" }>[],
  start: number,
  end: number,
): number {
  const byIssue = new Map<number | null, [number, number][]>();
  for (const entry of entries) {
    const began = epoch(entry.beganAt);
    const finished = epoch(entry.at);
    if (began === null || finished === null) continue;
    const left = Math.max(start, began);
    const right = Math.min(end, finished);
    if (right <= left) continue;
    const list = byIssue.get(entry.issue) ?? [];
    list.push([left, right]);
    byIssue.set(entry.issue, list);
  }
  let duration = 0;
  for (const intervals of byIssue.values()) {
    let cursor = start;
    for (const [left, right] of intervals.sort((a, b) => a[0] - b[0])) {
      duration += Math.max(0, right - Math.max(left, cursor));
      cursor = Math.max(cursor, right);
    }
  }
  return duration;
}

function turnMetrics(
  turns: readonly Extract<MetricObservation, { kind: "turn" }>[],
  merged: number | null,
  coverage: CoverageFor,
) {
  const standing = turns.filter(({ role }) => role !== "runner");
  const sampledStanding = sample(standing.map((turn) => numberOrNull(turn.tokens)));
  const standingCoverage = coverage("turns", standing.length);
  const tokens =
    !standing.length && standingCoverage === "complete"
      ? { ...sampledStanding, total: 0 }
      : sampledStanding;
  const origins = turns.filter(({ origin }) => origin !== null);
  const total = sample(origins.map((turn) => numberOrNull(turn.tokens)));
  function share(origin: "timer" | "event"): number | null {
    if (!total.total) return null;
    const subset = origins.filter((turn) => turn.origin === origin);
    if (!subset.length) return 0;
    const recorded = sample(subset.map((turn) => numberOrNull(turn.tokens)));
    return recorded.total === null ? null : recorded.total / total.total;
  }
  return {
    standingRoleTokensPerMergedPr: {
      tokens,
      merged,
      ratio: merged && tokens.total !== null ? tokens.total / merged : null,
      coverage: standingCoverage,
    },
    wakeTokenShare: {
      total,
      unknownOriginTurns: turns.length - origins.length,
      timerShare: share("timer"),
      eventShare: share("event"),
      coverage: coverage("turns", turns.length),
    },
  };
}

function quotaMetrics(
  observations: readonly MetricObservation[],
  start: number,
  end: number,
  coverage: CoverageFor,
) {
  const observationsOfQuota = observations.filter((entry) => entry.kind === "quota");
  const quota = observationsOfQuota.filter(
    (entry) => (epoch(entry.beganAt) ?? end) < end && (epoch(entry.at) ?? start) > start,
  );
  const eligible = quota.filter(({ alternateEligible }) => alternateEligible === true);
  const unknown = quota.filter(({ alternateEligible }) => alternateEligible === null);
  const evidence = coverage("quota", quota.length);
  return {
    issueHours:
      eligible.length || evidence === "complete"
        ? pairBoundedQuota(eligible, start, end) / 3_600_000
        : null,
    unknownEligibilityIssueHours: unknown.length
      ? pairBoundedQuota(unknown, start, end) / 3_600_000
      : null,
    coverage: evidence,
  };
}

function mergeCohorts(
  merges: readonly Extract<MetricObservation, { kind: "merge" }>[],
  firstBuilders: ReadonlyMap<number | null, ReturnType<typeof runEvidence>[number]>,
  days: number,
  dimension: "machine" | "machine-provider",
) {
  const cohorts = new Map<
    string,
    { machine: string | null; builderProvider: string | null; durations: (number | null)[] }
  >();
  for (const merge of merges) {
    const builder = firstBuilders.get(merge.issue);
    const builderProvider = builder?.provider ?? null;
    const machine = builder?.machine ?? null;
    const key = JSON.stringify(dimension === "machine" ? [machine] : [machine, builderProvider]);
    const entry = cohorts.get(key) ?? { machine, builderProvider, durations: [] };
    entry.durations.push(elapsed(builder?.openedAt, merge.at));
    cohorts.set(key, entry);
  }
  return [...cohorts.values()].map(({ machine, builderProvider, durations }) => ({
    machine,
    builderProvider: dimension === "machine-provider" ? builderProvider : null,
    merges: durations.length,
    perDay: durations.length / days,
    medianBuilderOpenToMergeMs: median(durations),
    withoutBuilderTimestamp: durations.filter((value) => value === null).length,
  }));
}

function verifiedReview(
  ledger: LeanMetricLedger,
  review: Extract<MetricObservation, { kind: "review" }>,
): Extract<MetricObservation, { kind: "review" }> {
  if (review.independence !== "unverified") return review;
  const trusted = Object.values(ledger.mergeIntents ?? {}).some(({ issue, approval }) => {
    const selected = approval.reviewAccountSelection;
    const reviewer = approval.verdict?.reviewer;
    return (
      issue === review.issue &&
      approval.verdict?.sha === review.sha &&
      selected?.mode === "same-account" &&
      review.id === `review:${issue}:${review.sha}:${reviewer?.agentId}`
    );
  });
  return trusted ? { ...review, independence: "verified-fallback" } : review;
}

export function readLeanMetrics(options: MetricOptions) {
  const { ledger, now, window } = options;
  const start = epoch(window.from);
  const end = epoch(window.until);
  if (start === null || end === null || end <= start)
    throw new Error("Use an increasing Factory metrics window.");
  const bounds = { start, end };
  function inWindow(value: string): boolean {
    const date = epoch(value);
    return date !== null && date >= bounds.start && date < bounds.end;
  }
  function coverage(source: MetricSource, samples: number): Coverage {
    return window.coverage?.[source] ?? (samples ? "partial" : "unavailable");
  }
  function observedCount(source: MetricSource, count: number): number | null {
    return count || coverage(source, count) === "complete" ? count : null;
  }

  const observations = Object.values(ledger.metricObservations ?? {});
  const scoped = observations.filter(({ at }) => inWindow(at));
  const turns = scoped.filter((entry) => entry.kind === "turn");
  const stalls = scoped.filter((entry) => entry.kind === "stall");
  const activityStalls = (options.activity ?? []).filter(
    (entry) => entry.kind === "stall-detected" && inWindow(entry.at),
  );
  const questions = ledger.escalations.filter(({ openedAt }) => inWindow(openedAt));
  const claims = scoped.filter((entry) => entry.kind === "claim");
  const merges = scoped.filter((entry) => entry.kind === "merge");
  const settled = [
    ...new Map(
      merges
        .filter((item) => item.outcome === "settled")
        .map((item) => [JSON.stringify([item.issue, item.mergeSha ?? item.id]), item]),
    ).values(),
  ];
  const installs = scoped.filter((entry) => entry.kind === "install-finding");
  const verifiedInstalls = installs.filter((entry) => {
    const receipt = ledger.delivery.receipts.find((item) => item.jobId === entry.jobId);
    return (
      receipt?.kind === "deliver" &&
      receipt.outcome === "delivered" &&
      elapsed(receipt.verifiedAt, entry.at) !== null
    );
  });
  const firstBuilders = new Map<number | null, ReturnType<typeof runEvidence>[number]>();
  const issueIds = new Set<number>();
  for (const item of [...observations, ...Object.values(ledger.runners)]) {
    if (item.issue !== null) issueIds.add(item.issue);
  }
  for (const records of [
    ledger.metricStages,
    ledger.runtimeMerges,
    ledger.acceptances,
    ledger.leases,
  ]) {
    for (const id of Object.keys(records ?? {}))
      if (Number.isSafeInteger(Number(id)) && Number(id) > 0) issueIds.add(Number(id));
  }
  for (const question of questions) for (const issue of question.blocksIssues) issueIds.add(issue);
  const issues = [...issueIds]
    .sort((a, b) => a - b)
    .map((issue) => {
      const runs = runEvidence(ledger, issue, now, options.localMachine);
      const first = runs.find(({ role }) => role === "lead");
      if (first) firstBuilders.set(issue, first);
      const visits = (ledger.metricStages?.[issue] ?? []).map(
        ({ generation, stage, since, until }) => ({
          generation,
          stage,
          since,
          until,
          elapsedMs: elapsed(since, until ?? now.toISOString()),
        }),
      );
      const reviews = scoped
        .filter(
          (entry): entry is Extract<MetricObservation, { kind: "review" }> =>
            entry.kind === "review" && entry.issue === issue,
        )
        .map((review) => verifiedReview(ledger, review));
      const sendBacks = (ledger.acceptances[issue] ?? []).filter(
        (entry) => entry.outcome === "sent-back" && inWindow(entry.at),
      );
      const merge = settled.find((entry) => entry.issue === issue);
      const ownerQuestions = questions.filter((item) => item.blocksIssues.includes(issue));
      const permissions = scoped.filter(
        (entry) => entry.kind === "permission-grant" && entry.issue === issue,
      );
      const mergeAttempts = merges.filter((entry) => entry.issue === issue);
      return {
        issue,
        runs,
        stages: visits,
        builderProviders: [
          ...new Set(runs.filter(({ role }) => role === "lead").map(({ provider }) => provider)),
        ],
        reviews,
        findings: sample(reviews.map(({ findings }) => findings)),
        independenceUnverified: reviews.length
          ? reviews.filter(
              (entry) =>
                entry.independence === "unverified" || entry.independence === "unverified-foreign",
            ).length
          : null,
        sendBacks: sendBacks.map(({ at, sha, improvements }) => ({
          at,
          sha,
          improvements: improvements.length,
        })),
        ownerQuestions: observedCount("questions", ownerQuestions.length),
        manualPermissionGrants: observedCount("permissions", permissions.length),
        builderOpenToMergeMs: elapsed(first?.openedAt, merge?.at),
        merge: merge ?? ledger.runtimeMerges?.[issue] ?? null,
        mergeAttempts,
        linkedPostInstallFindings: observedCount(
          "installs",
          verifiedInstalls.filter((entry) => entry.issue === issue).length,
        ),
        claimIncidents: claims
          .filter((entry) => entry.issue === issue)
          .map(({ at, result }) => ({ at, result })),
      };
    });
  const merged = observedCount("merges", settled.length);
  const days = (end - start) / day;
  const questionCount = observedCount("questions", questions.length);
  return {
    window: { from: window.from, until: window.until },
    issues,
    ...turnMetrics(turns, merged, coverage),
    quotaStoppedWithEligibleAlternate: quotaMetrics(observations, start, end, coverage),
    stallDetection: {
      fromStallMs: stalls.map((entry) => ({
        issue: entry.issue,
        ms: elapsed(entry.stallStartedAt, entry.at),
      })),
      deadlineLagMs: stalls.map((entry) => ({
        issue: entry.issue,
        ms: elapsed(entry.deadline, entry.at),
      })),
      // Older activity logs identify measured deadline lag only. Keep them separate from structured samples.
      legacyDeadlineLagMs: activityStalls.map((entry) => ({
        issue: entry.issue,
        firstBreach: entry.class === "mechanical",
        ms: numberOrNull(Number(/(\d+) ms after the deadline\./.exec(entry.text)?.[1])),
      })),
      coverage: coverage("stalls", stalls.length + activityStalls.length),
    },
    flow: {
      merged,
      perDay: merged === null ? null : (merged * day) / (end - start),
      medianBuilderOpenToMergeMs: median(
        issues.map(({ builderOpenToMergeMs }) => builderOpenToMergeMs),
      ),
      byMachine: mergeCohorts(settled, firstBuilders, days, "machine"),
      byMachineAndBuilderProvider: mergeCohorts(settled, firstBuilders, days, "machine-provider"),
      coverage: coverage("merges", settled.length),
      daemonObservedTimestamps: settled.filter((merge) => merge.timeBasis === "daemon-observed")
        .length,
    },
    ownerQuestionsPerMergedPr: {
      questions: questionCount,
      merged,
      coverage: coverage("questions", questions.length),
      ratio: merged && questionCount !== null ? questionCount / merged : null,
    },
    claimConflicts: {
      stale: observedCount("claims", claims.filter(({ result }) => result === "stale").length),
      conflicting: observedCount(
        "claims",
        claims.filter(({ result }) => result === "conflict").length,
      ),
      perWeek:
        observedCount("claims", claims.length) === null
          ? null
          : (claims.length * 7 * day) / (end - start),
      coverage: coverage("claims", claims.length),
    },
    postInstallDefects: {
      defects: observedCount(
        "installs",
        verifiedInstalls.filter(({ result }) => result === "defect").length,
      ),
      installsPastRed: observedCount(
        "installs",
        new Set(
          verifiedInstalls
            .filter(({ result }) => result === "past-red-check")
            .map(({ jobId }) => jobId),
        ).size,
      ),
      withoutVerifiedDelivery: installs.length - verifiedInstalls.length,
      coverage: coverage("installs", verifiedInstalls.length),
    },
  };
}

/** Pure preview of the dispatcher. The supplied lane set describes the proposed live authority. */
export function auditLeanShadow(input: {
  mode: "dry-run" | "review-rehearsal";
  facts: GitHubFacts;
  ledger: IssueLedger;
  context: DispatchContext;
}) {
  const { mode, facts, ledger, context } = input;
  const stages = deriveStages(facts, ledger, context.here);
  const actions = plan(stages, ledger, context).map((action) => ({
    kind: action.kind,
    issue: "issue" in action ? action.issue : null,
    eligibleForRehearsal:
      mode === "review-rehearsal" && action.kind !== "merge" && action.kind !== "start-delivery",
  }));
  return {
    mode,
    installation: context.here,
    observedAt: facts.readAt,
    ledgerRevision: ledger.revision,
    lanesAssumed: [...context.lanesHeld],
    issues: [...stages].map(([issue, stage]) => ({ issue, stage: stage.kind })),
    actions,
  };
}
