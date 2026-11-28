import type {
  AdmissionFacts,
  GitHubFacts,
  Installation,
  IssueStage,
  LeanLedger,
  Lease,
  PullFacts,
  RunnerRef,
  PullRef,
  RunnerRole,
  Verdict,
} from "./types.js";

/** Local verdicts enter only through the daemon's authenticated reviewer result handler. */
export interface IssueLedger extends LeanLedger {
  localVerdicts?: Record<string, Verdict>;
}

function stage(
  issue: AdmissionFacts,
  facts: GitHubFacts,
  ledger: IssueLedger,
  here: Installation,
): IssueStage | null {
  const lease = facts.leases.find((item) => item.issue === issue.number && !item.released);
  if (!lease && !issue.labels.includes("factory:ready")) return null;
  const pull = lease && facts.pulls.find((item) => item.sameRepo && item.branch === lease.branch);
  if (lease && lease.installation !== here && (!pull || pull.foreignReviewHead !== pull.head))
    return { kind: "foreign", installation: lease.installation };
  if (!issue.trust.trusted)
    return {
      kind: "parked",
      reason: { kind: "untrusted", reason: issue.trust.reason },
      until: null,
    };
  if (issue.labels.includes("factory:blocked"))
    return { kind: "blocked", reason: "The issue is blocked." };
  if (!lease) return { kind: "queued" };
  const runners = Object.values(ledger.runners).filter((item) => item.issue === issue.number);
  const open = (role: RunnerRole) =>
    runners.find((item) => item.role === role && !item.closedAt) ?? null;
  const lead = open("lead");
  if (!pull) {
    if (!lead) return { kind: "claimed", lease };
    if (!issue.plan) return { kind: "planning", lease, lead };
    if (issue.go) return { kind: "building", lease, lead };
    const overlap = facts.issues.find(
      (other) =>
        other.number !== issue.number &&
        other.go?.files.some((file) => issue.plan?.files.includes(file)),
    );
    if (overlap) return { kind: "deferred", lease, lead, overlapsIssue: overlap.number };
    return { kind: "plan-ready", lease, lead, files: issue.plan.files };
  }
  return pullStage(issue, ledger, lease, pull, lead, open, runners);
}

function pullStage(
  issue: AdmissionFacts,
  ledger: IssueLedger,
  lease: Lease,
  pull: PullFacts,
  lead: RunnerRef | null,
  open: (role: RunnerRole) => RunnerRef | null,
  runners: RunnerRef[],
): IssueStage {
  const pr: PullRef = { number: pull.number, headSha: pull.head, checks: pull.checks };
  if (pull.checks === "failing")
    return { kind: "repair", lease, pr, findings: "Required checks failed.", lead };
  if (pull.checks !== "passing" && !pull.reviewEligible) return { kind: "checks", lease, pr };
  const verdict = ledger.localVerdicts?.[issue.number];
  if (
    verdict?.sha !== pr.headSha ||
    verdict.source !== "local-runner" ||
    !runners.some((item) => item.role === "reviewer" && item.agentId === verdict.reviewer.agentId)
  ) {
    return { kind: "review", lease, pr, reviewer: open("reviewer") };
  }
  if (!verdict.approved)
    return {
      kind: "repair",
      lease,
      pr,
      findings: verdict.findings ?? "Reviewer requested changes.",
      lead,
    };
  if (pull.checks !== "passing") return { kind: "checks", lease, pr };
  const acceptance = ledger.acceptances[issue.number]?.at(-1);
  if (
    acceptance?.sha !== pr.headSha ||
    acceptance.source !== "local-session" ||
    !runners.some((item) => item.role === "foreman-op" && item.agentId === acceptance.session)
  ) {
    return { kind: "accepting", lease, pr, verdict, session: open("foreman-op") };
  }
  if (acceptance.outcome === "escalated")
    return { kind: "blocked", reason: "Waiting for the owner's decision." };
  if (acceptance.outcome === "sent-back")
    return {
      kind: "sent-back",
      lease,
      pr,
      improvements: acceptance.improvements,
      round: ledger.acceptances[issue.number].filter((item) => item.outcome === "sent-back").length,
      lead,
    };
  return { kind: "approved", lease, pr, verdict, acceptance };
}

export function deriveStages(
  facts: GitHubFacts,
  ledger: IssueLedger,
  here: Installation,
): Map<number, IssueStage> {
  const stages = new Map<number, IssueStage>();
  const ordered = [...facts.issues].sort(
    (a, b) =>
      Number(b.priority) - Number(a.priority) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.number - b.number,
  );
  for (const issue of ordered) {
    const current = stage(issue, facts, ledger, here);
    if (current) stages.set(issue.number, current);
  }
  return stages;
}
