import type { FactoryQueueIssue } from "@/components/sidebar/factory-card-model";
import type { FactoryChip } from "@/components/sidebar/factory-card-roles";
import type { LeanRunnerRef, LeanStatus, LeanView } from "./lean-factory-source";

/**
 * Pure view models for lean Factories. Fed by the adapter's shapes; no React, no RPCs.
 *
 * Naming: the owner calls the conversational role the Lead and the per-issue runner the Builder.
 * The wire keeps its older names: RunnerRole "lead" is the Builder, and "foreman-op" and
 * "mechanic" sessions are the Lead's and Mechanic's own work, not runners.
 */

export type LeanRunnerRole = "builder" | "reviewer" | "delivery";

const RUNNER_ROLE_BY_WIRE: Record<string, LeanRunnerRole | undefined> = {
  lead: "builder",
  reviewer: "reviewer",
  delivery: "delivery",
};

/** Stages where the issue needs repair or is stuck, lit as danger on the runner track. */
const DANGER_STAGES = new Set(["repair", "sent-back", "parked", "blocked"]);

/** Lean issue stages on the five-step runner track the sidebar already draws. */
const QUEUE_STAGE_BY_LEAN: Record<
  string,
  "queued" | "planning" | "building" | "review" | "repair" | "merging" | "blocked"
> = {
  queued: "queued",
  claimed: "planning",
  planning: "planning",
  "plan-ready": "planning",
  deferred: "queued",
  building: "building",
  checks: "building",
  review: "review",
  repair: "repair",
  accepting: "review",
  "sent-back": "repair",
  approved: "merging",
  merged: "merging",
  parked: "blocked",
  blocked: "blocked",
  foreign: "queued",
};

export function leanQueueStage(stage: string) {
  return QUEUE_STAGE_BY_LEAN[stage] ?? "queued";
}

type Machines = LeanView["machines"];

/**
 * A machine's short name: the owner's friendly name, else the server half of
 * `<serverId>/<projectId>`, which is what tells two machines of one project apart.
 */
export function leanMachineName(installation: string | null, machines: Machines): string | null {
  if (!installation) return null;
  const known = machines.find((machine) => machine.installation === installation);
  if (known?.friendlyName) return known.friendlyName;
  return installation.split("/")[0] || installation;
}

export interface LeanRunnerRow {
  key: string;
  /** Null for a delivery runner, which works on a batch rather than one issue. */
  issue: number | null;
  title: string;
  role: LeanRunnerRole;
  agentId: string;
  /** The runner's host when this daemon has a route to it; null means this host. */
  serverId: string | null;
  machine: string | null;
  /** The lean stage kind, for the runner track. */
  stage: string;
  danger: boolean;
}

/**
 * Every runner working now: Builders and Reviewers from the issue lines, then the Delivery
 * runner when one holds the delivery lock. The executor holding the lock is not a runner.
 */
export function leanRunnerRows(status: LeanStatus | null, view: LeanView | null): LeanRunnerRow[] {
  const machines = view?.machines ?? [];
  const rows: LeanRunnerRow[] = [];
  for (const line of status?.issues ?? view?.inFlight ?? []) {
    const runner = line.runner as LeanRunnerRef | null;
    const role = runner ? RUNNER_ROLE_BY_WIRE[runner.role] : undefined;
    if (!runner || !role) continue;
    rows.push({
      key: `issue-${line.issue}-${runner.agentId}`,
      issue: line.issue,
      title: line.title,
      role,
      agentId: runner.agentId,
      serverId: runner.serverId,
      // The runner's own machine. The line's installation is the Builder's, which is wrong for
      // a Reviewer on the primary reviewing a secondary's work; older daemons send only that.
      machine:
        runner.friendlyName || leanMachineName(runner.installation ?? line.installation, machines),
      stage: line.stage,
      danger: DANGER_STAGES.has(line.stage),
    });
  }
  const lock = view?.health.deliveryLock;
  if (lock?.holder.kind === "runner" && lock.holder.agentId) {
    rows.push({
      key: `delivery-${lock.holder.agentId}`,
      issue: null,
      title: lock.batch,
      role: "delivery",
      agentId: lock.holder.agentId,
      serverId: null,
      machine: leanMachineName(lock.holder.installationId ?? null, machines),
      stage: "merged",
      danger: false,
    });
  }
  return rows;
}

/** Whether a beta is newer than production by its release time; with no production, all are. */
export function isNewerThanProduction(
  event: { at: string; id: string },
  production: { at: string; id: string } | null,
): boolean {
  if (!production) return true;
  if (event.id === production.id) return false;
  return Date.parse(event.at) > Date.parse(production.at);
}

export type LeanNeedsYouItem =
  | {
      kind: "delivery-failed";
      key: string;
      jobId: string;
      /** The run's kind: beta, promote or rollback. */
      deliveryKind: string;
      version: string | null;
      /** "unknown" when the step's outcome is not known, else "step-failed". */
      failureKind: string;
      reason: string | null;
    }
  | { kind: "question"; key: string; id: string; question: string; blocksIssues: number[] }
  | { kind: "approval"; key: string; jobId: string; version: string | null; url: string | null }
  | {
      kind: "beta-notice";
      key: string;
      eventId: string;
      version: string;
      shipsAt: string;
      held: boolean;
    }
  | { kind: "promote"; key: string; version: string; count: number };

/**
 * What waits on the owner, most urgent first: a failed or unknown delivery to settle, a beta about
 * to reset occupied rooms (which ships unless held), delivery approvals, open questions, then
 * whether to promote the newest beta.
 */
export function leanNeedsYou(status: LeanStatus | null, view: LeanView | null): LeanNeedsYouItem[] {
  const items: LeanNeedsYouItem[] = [];
  // Nothing ships until the owner settles a failed or unknown delivery, so it leads.
  const stuck = view?.delivery;
  if (stuck && (stuck.failureKind === "unknown" || stuck.failureKind === "step-failed")) {
    items.push({
      kind: "delivery-failed",
      key: `delivery-failed-${stuck.jobId}`,
      jobId: stuck.jobId,
      deliveryKind: stuck.kind,
      version: stuck.version,
      failureKind: stuck.failureKind,
      reason: stuck.failureReason,
    });
  }
  const beta = view?.pendingBeta;
  if (beta) {
    items.push({
      kind: "beta-notice",
      key: `beta-notice-${beta.eventId}`,
      eventId: beta.eventId,
      version: beta.version,
      shipsAt: beta.shipsAt,
      held: beta.held,
    });
  }
  const delivery = view?.delivery;
  if (delivery?.state === "awaiting-approval") {
    items.push({
      kind: "approval",
      key: `approval-${delivery.jobId}`,
      jobId: delivery.jobId,
      version: delivery.version,
      url: delivery.approvalUrl,
    });
  }
  for (const escalation of status?.escalations ?? []) {
    items.push({
      kind: "question",
      key: `question-${escalation.id}`,
      id: escalation.id,
      question: escalation.question,
      blocksIssues: escalation.blocksIssues,
    });
  }
  const promotable = view ? leanPromotableBetas(view) : [];
  const newest = promotable[0];
  if (newest) {
    items.push({
      kind: "promote",
      key: `promote-${newest.id}`,
      version: newest.version,
      count: promotable.length,
    });
  }
  return items;
}

/** Betas the owner can promote now, newest first. A failed beta is never offered. */
export function leanPromotableBetas(view: Pick<LeanView, "betas" | "production">) {
  return view.betas
    .filter((event) => event.kind === "beta" && isNewerThanProduction(event, view.production))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

/** The two lean tiles, Lead first. Role labels are product names, as the crew tiles' are. */
export const LEAN_TILE_ROLES = [
  { key: "factory-intake", label: "Lead" },
  { key: "factory-mechanic", label: "Mechanic" },
] as const;

/**
 * The Lead and Mechanic tiles from the Factory's role chips. A fresh lean project may have no
 * record for either yet; its tile stays, with nothing to open, instead of disappearing.
 */
export function leanTiles(chips: readonly FactoryChip[]): FactoryChip[] {
  return LEAN_TILE_ROLES.map(({ key, label }) => {
    const chip = chips.find((candidate) => candidate.key === key);
    // A copy, so relabeling never changes the shared chip.
    const tile: FactoryChip = chip
      ? Object.assign({}, chip)
      : { key, label, entry: null, status: undefined, isRole: true };
    tile.label = label;
    return tile;
  });
}

type QueueIssue = FactoryQueueIssue;
const QUEUE_CHECKS = new Set(["pending", "passing", "failing"]);

/** A lean issue line in the queue shape the stage bar and runner rows already draw. */
function queueIssue(line: LeanStatus["issues"][number]): QueueIssue {
  return {
    number: line.issue,
    title: line.title,
    url: "",
    label: line.runner ? "running" : "ready",
    stage: leanQueueStage(line.stage),
    pr: line.pr
      ? {
          number: line.pr.number,
          url: "",
          headSha: line.pr.headSha,
          checks: QUEUE_CHECKS.has(line.pr.checks)
            ? (line.pr.checks as "pending" | "passing" | "failing")
            : null,
          reviewDecision: null,
        }
      : null,
    agents: [],
  };
}

/** Every open lean issue for the section's stage bar. */
export function leanStageBarIssues(status: LeanStatus | null): QueueIssue[] | null {
  return status ? status.issues.map(queueIssue) : null;
}

/** A runner row in the sidebar's runner shape, with its lean role and machine badge. */
export type LeanRunnerIssue = QueueIssue & {
  serverId?: string;
  machine?: string;
  leanRole?: LeanRunnerRole;
};

/** Runner rows for the shared Runners group. Each opens its runner's agent on its own host. */
export function leanRunnerIssues(
  rows: readonly LeanRunnerRow[],
  status: LeanStatus | null,
): LeanRunnerIssue[] {
  return rows.map((row) => {
    const line = status?.issues.find(
      (candidate) => candidate.issue === row.issue && candidate.runner?.agentId === row.agentId,
    );
    const base: QueueIssue = line
      ? queueIssue(line)
      : {
          number: row.issue ?? 0,
          title: row.title,
          url: "",
          label: "running",
          stage: leanQueueStage(row.stage),
          pr: null,
          agents: [],
        };
    return {
      ...base,
      // Role "worker" makes the shared row open this agent first.
      agents: [{ role: "worker", agentId: row.agentId, status: "running" }],
      ...(row.serverId ? { serverId: row.serverId } : {}),
      ...(row.machine ? { machine: row.machine } : {}),
      leanRole: row.role,
    };
  });
}

type ReleaseEvent = NonNullable<LeanView["production"]>;

/** The one exact release an owner action targets, with the production it expects to replace. */
export type LeanReleaseAction =
  | { kind: "promote"; eventId: string; version: string; expectedProduction: string | null }
  | { kind: "rollback"; targetEventId: string; version: string; expectedProduction: string };

export interface LeanReleaseRow {
  event: ReleaseEvent;
  action: LeanReleaseAction | null;
}

export interface LeanReleases {
  production: ReleaseEvent | null;
  /** Betas newer than production, newest first; each passing beta offers Promote. */
  betas: LeanReleaseRow[];
  /** Releases before production, newest first; each stable one offers Roll back. */
  earlier: LeanReleaseRow[];
}

const byNewest = (left: ReleaseEvent, right: ReleaseEvent) =>
  Date.parse(right.at) - Date.parse(left.at);

/**
 * Which releases the owner can act on. Promote targets one beta newer than production; Roll back
 * targets one earlier stable release and needs a production to replace. A failed release, or
 * the production release itself, offers neither. Each action carries the production event id
 * the daemon checks, so a press made against a stale page is refused rather than applied.
 */
export function leanReleases(
  view: Pick<LeanView, "production" | "betas" | "earlier">,
): LeanReleases {
  const production = view.production;
  const expected = production?.id ?? null;
  const betas = view.betas
    .filter((event) => event.id !== production?.id && isNewerThanProduction(event, production))
    .sort(byNewest)
    .map(
      (event): LeanReleaseRow => ({
        event,
        action:
          event.kind === "beta"
            ? {
                kind: "promote",
                eventId: event.id,
                version: event.version,
                expectedProduction: expected,
              }
            : null,
      }),
    );
  const earlier = view.earlier
    .filter((event) => event.id !== production?.id)
    .sort(byNewest)
    .map(
      (event): LeanReleaseRow => ({
        event,
        action:
          production &&
          event.channel === "stable" &&
          event.kind !== "failed" &&
          event.version !== production.version
            ? {
                kind: "rollback",
                targetEventId: event.id,
                version: event.version,
                expectedProduction: production.id,
              }
            : null,
      }),
    );
  return { production, betas, earlier };
}

/** Plain health lines: the watchdog's alerts once each, then an invalid release recipe. */
export function leanHealthAlerts(status: LeanStatus | null, view: LeanView | null): string[] {
  const alerts = new Set([...(status?.alerts ?? []), ...(view?.health.alerts ?? [])]);
  if (view && !view.recipe.valid) alerts.add(view.recipe.error ?? "");
  return [...alerts].filter((alert) => alert.length > 0);
}

/** Owner actions on a lean Factory, each gated on the daemon's readiness. */
export type LeanOwnerAction =
  | "hold"
  | "promote"
  | "rollback"
  | "approval"
  | "resolve"
  | "config-save";

/** Why an action is unavailable: no verified owner route, or no wired delivery executor. */
export type LeanActionBlock = "owner" | "delivery";

const NEEDS_DELIVERY = new Set<LeanOwnerAction>(["hold", "promote", "rollback"]);

/**
 * Null when the owner may take the action now, else why not. Every action needs the owner
 * route; Hold, Let it ship, Promote and Roll back also need the delivery executor. Callers show
 * a blocked action disabled with its reason, never hidden.
 */
export function leanActionBlock(
  readiness: LeanView["readiness"] | null | undefined,
  action: LeanOwnerAction,
): LeanActionBlock | null {
  if (!readiness?.ownerActions) return "owner";
  if (NEEDS_DELIVERY.has(action) && !readiness.deliveryActions) return "delivery";
  return null;
}
