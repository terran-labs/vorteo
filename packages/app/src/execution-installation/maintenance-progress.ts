import type { RestartJob, RestartSummary } from "@getpaseo/protocol/execution-installation";
import type { MaintenanceServiceView } from "@getpaseo/protocol/maintenance-service-status";
import { jobOwnerState, restartOwnerState } from "./owner-waiting";

/**
 * Installation maintenance that is running now, in one shape for every surface that shows it:
 * the sidebar row, the phone entry, the Host and Dev rows in Settings > System, Health and the
 * composer's held message (#720). They all read this model, so they cannot disagree.
 *
 * Only tracked lifecycle state counts: restart and update requests and the maintenance service
 * queue, as the coordinator reports them. Nothing here infers maintenance from a failed send.
 * Work waiting on the owner's approval is not progress; it keeps its own attention badge.
 */

/**
 * Host and Dev are the two daemons. System services are the coordinator's own maintenance (the
 * maintenance controller and recovery launcher), named as Settings already names them.
 */
export type MaintenanceTarget = "host" | "dev" | "system";

/** What the operation is doing, in steps the interface words for the owner. */
export type MaintenancePhase =
  | "preparing"
  | "starting"
  | "preparing-update"
  | "waiting-for-idle"
  | "holding-turns"
  | "installing"
  | "restarting"
  | "running"
  | "checking"
  /** A step this app does not know yet; `stepText` carries the coordinator's own word. */
  | "other";

/**
 * Optional progress fields the coordinator will report (#720, Builds' lifecycle fields). Read
 * only when present; every surface falls back to what the job already records.
 */
interface ProgressFields {
  startedAt?: string;
  step?: string;
  stepStartedAt?: string;
  holdStartedAt?: string;
  holdDeadlineAt?: string;
  holdReleasedAt?: string | null;
  finishedAt?: string;
  requesterNotice?: string;
  /** History first seen at coordinator startup, past approval: start times are unknown. */
  progressReconstructed?: boolean;
}
type ProgressJob = RestartJob & ProgressFields;
type ProgressService = MaintenanceServiceView & ProgressFields;
type ImpactAgent = NonNullable<RestartJob["impact"]>["agents"][number] & {
  waitingSince?: string;
  turnStartedAt?: string;
};

export interface MaintenanceBlocker {
  agentId: string;
  /** The thread's title, only when the owner can open that thread in this app. */
  title: string | null;
  /** The agent's state as the coordinator last saw it, such as "running". */
  status: string;
  /** When the coordinator first saw this thread holding the operation. */
  waitingSince: string | null;
  /** When the thread's current turn started, when its daemon reports it. */
  turnStartedAt: string | null;
}

/** Where a timer starts, so its label can say what it measures. */
export type TimerStart = "started" | "approved" | "requested";

export interface MaintenanceEstimate {
  medianMs: number;
  minMs: number;
  maxMs: number;
  samples: number;
}

export interface MaintenanceOperation {
  /** Stable across refreshes: the request or job id. */
  id: string;
  target: MaintenanceTarget;
  kind: "update" | "restart" | "maintenance";
  phase: MaintenancePhase;
  /** The coordinator's step word when `phase` is "other". */
  stepText: string | null;
  /** New messages to this target are held until the operation finishes. */
  holdsMessages: boolean;
  /** The turn hold passed its deadline; the owner must decide. */
  overdue: boolean;
  /** When the turn hold's deadline falls, when the coordinator reports it. */
  overdueAt: string | null;
  /** An agent asked for this hold, it passed its deadline, and that agent was not notified. */
  requesterNotNotified: boolean;
  /**
   * The coordinator rebuilt this operation's history at its startup, so when it and its current
   * step began is unknown. Shown as unknown, never as the coordinator's startup time.
   */
  startUnknown: boolean;
  /** When the operation's timer starts, and what that moment was. */
  since: { at: string; from: TimerStart } | null;
  /** When the current step began; null until the coordinator reports steps. */
  stepSince: string | null;
  /** Threads a turn hold still waits for. */
  blockers: MaintenanceBlocker[];
  /** When the coordinator last checked those threads. */
  blockersCheckedAt: string | null;
  /** Usual duration from finished operations of the same target and kind, or null. */
  estimate: MaintenanceEstimate | null;
}

export interface MaintenanceProgress {
  operations: MaintenanceOperation[];
  /**
   * Installation controls are locked, so only public counts are known: maintenance is running,
   * without targets or thread titles. Null when unlocked or when nothing runs.
   */
  locked: { running: number; queued: number } | null;
  /** The last successful read is too old to trust; times keep counting from it. */
  staleSince: string | null;
}

export interface MaintenanceProgressInput {
  unlocked: boolean;
  jobs: readonly RestartJob[];
  serviceJobs: readonly MaintenanceServiceView[];
  summary: RestartSummary | null;
  /** When the coordinator last answered. */
  lastUpdatedAt: string | null;
  now: number;
  /**
   * The title of a thread the owner can open in this app, or null. Blockers on threads the app
   * does not list stay anonymous, so global status never reveals another workspace's thread.
   */
  visibleThread: (target: "host" | "dev", agentId: string) => string | null;
}

/** The app polls every 5 seconds; three missed reads make the snapshot stale. */
export const MAINTENANCE_STALE_MS = 20_000;
/** An estimate needs at least this many finished operations of the same target and kind. */
export const ESTIMATE_MIN_SAMPLES = 3;
const ESTIMATE_WINDOW = 10;

/** The coordinator's step names (#720 lifecycle fields); its set may grow. */
const PHASE_BY_STEP: Record<string, MaintenancePhase> = {
  "awaiting-approval": "preparing",
  "waiting-to-start": "starting",
  preparing: "preparing-update",
  "waiting-for-idle": "waiting-for-idle",
  "holding-turns": "holding-turns",
  // One opaque execution: build, restart and readiness checks are not reported separately.
  restarting: "restarting",
  running: "running",
  observing: "checking",
};
const TERMINAL_STEPS = new Set(["succeeded", "failed", "rejected"]);

/** The phase a reported step names, "other" for an unknown one, or null when none reported. */
function reportedPhase(step: string | undefined): MaintenancePhase | null {
  if (!step || TERMINAL_STEPS.has(step)) return null;
  return PHASE_BY_STEP[step] ?? "other";
}

function restartTarget(target: RestartJob["target"]): "host" | "dev" {
  return target === "host" ? "host" : "dev";
}

function restartKind(job: Pick<RestartJob, "update" | "sourceBatch">): "update" | "restart" {
  return job.update || job.sourceBatch ? "update" : "restart";
}

/** A turn hold keeps new messages out until the restart or update finishes or is cancelled. */
export function holdsMessages(job: ProgressJob): boolean {
  if (!job.finishCurrentTurns || job.holdReleased || job.holdReleasedAt) return false;
  return job.status === "approved" || job.status === "running";
}

function restartPhase(job: ProgressJob): MaintenancePhase {
  const reported = reportedPhase(job.step);
  // A dispatched update both installs and restarts; say which kind of work it is.
  if (reported === "restarting" && restartKind(job) === "update") return "installing";
  if (reported) return reported;
  if (job.status === "pending") return "preparing";
  if (holdsMessages(job) && job.status === "approved") return "holding-turns";
  if (job.whenIdle && job.status === "approved") return "waiting-for-idle";
  if (job.status === "approved") return "starting";
  if (job.updatePreparation === "preparing") return "preparing-update";
  return restartKind(job) === "update" ? "installing" : "restarting";
}

function restartSince(job: ProgressJob): MaintenanceOperation["since"] {
  // Rebuilt at coordinator startup: when it began is unknown, so no timer at all.
  if (job.progressReconstructed) return null;
  if (job.startedAt) return { at: job.startedAt, from: "started" };
  if (job.approvedAt) return { at: job.approvedAt, from: "approved" };
  return { at: job.createdAt, from: "requested" };
}

/** A step start the coordinator reported; never the operation start standing in for it. */
function restartStepSince(job: ProgressJob, phase: MaintenancePhase): string | null {
  if (job.stepStartedAt) return job.stepStartedAt;
  if (phase === "holding-turns" && job.holdStartedAt) return job.holdStartedAt;
  return null;
}

function durationMs(entry: ProgressFields): number | null {
  if (!entry.startedAt || !entry.finishedAt) return null;
  const ms = Date.parse(entry.finishedAt) - Date.parse(entry.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * The usual duration from the most recent finished operations of the same target and kind, or
 * null when there are too few to say. Only measured start and finish times count.
 */
export function maintenanceEstimate(
  history: readonly (ProgressFields & { finished: boolean })[],
): MaintenanceEstimate | null {
  const durations = history
    .filter((entry) => entry.finished)
    .map(durationMs)
    .filter((ms): ms is number => ms !== null)
    .slice(0, ESTIMATE_WINDOW)
    .sort((left, right) => left - right);
  if (durations.length < ESTIMATE_MIN_SAMPLES) return null;
  const middle = Math.floor(durations.length / 2);
  const medianMs =
    durations.length % 2 ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2;
  return {
    medianMs,
    minMs: durations[0]!,
    maxMs: durations[durations.length - 1]!,
    samples: durations.length,
  };
}

function newestFirst(left: { createdAt: string }, right: { createdAt: string }): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt);
}

function restartOperation(
  job: ProgressJob,
  jobs: readonly ProgressJob[],
  visibleThread: MaintenanceProgressInput["visibleThread"],
): MaintenanceOperation {
  const target = restartTarget(job.target);
  const kind = restartKind(job);
  const phase = restartPhase(job);
  const holding = holdsMessages(job);
  const history = jobs
    .filter(
      (other) =>
        other.id !== job.id &&
        other.status === "succeeded" &&
        !other.progressReconstructed &&
        other.target === job.target &&
        restartKind(other) === kind,
    )
    .sort(newestFirst)
    .map((other) => ({ startedAt: other.startedAt, finishedAt: other.finishedAt, finished: true }));
  const agents = (holding ? (job.impact?.agents ?? []) : []) as ImpactAgent[];
  return {
    id: job.id,
    target,
    kind,
    phase,
    stepText: phase === "other" ? (job.step ?? null) : null,
    holdsMessages: holding,
    overdue: job.holdDeadlineExceeded === true,
    overdueAt: holding ? (job.holdDeadlineAt ?? null) : null,
    requesterNotNotified: job.requesterNotice === "not-notified",
    startUnknown: job.progressReconstructed === true,
    since: restartSince(job),
    stepSince: restartStepSince(job, phase),
    blockers: agents.map((agent) => ({
      agentId: agent.id,
      title: visibleThread(target, agent.id),
      status: agent.status,
      waitingSince: agent.waitingSince ?? null,
      turnStartedAt: agent.turnStartedAt ?? null,
    })),
    blockersCheckedAt: holding ? (job.impact?.checkedAt ?? null) : null,
    estimate: maintenanceEstimate(history),
  };
}

/** No timer for history rebuilt at coordinator startup; otherwise from start, else request. */
function serviceSince(job: ProgressService): MaintenanceOperation["since"] {
  if (job.progressReconstructed) return null;
  if (job.startedAt) return { at: job.startedAt, from: "started" };
  return { at: job.createdAt, from: "requested" };
}

function serviceOperation(
  job: ProgressService,
  services: readonly ProgressService[],
): MaintenanceOperation {
  const reported = reportedPhase(job.step);
  const history = services
    .filter(
      (other) =>
        other.id !== job.id &&
        other.status === "succeeded" &&
        !other.progressReconstructed &&
        other.target === job.target &&
        other.operation === job.operation,
    )
    .sort(newestFirst)
    .map((other) => ({ startedAt: other.startedAt, finishedAt: other.finishedAt, finished: true }));
  return {
    id: job.id,
    target: "system",
    kind: "maintenance",
    phase: reported ?? (job.status === "approved" ? "starting" : "running"),
    stepText: reported === "other" ? (job.step ?? null) : null,
    holdsMessages: false,
    overdue: false,
    overdueAt: null,
    requesterNotNotified: false,
    startUnknown: job.progressReconstructed === true,
    since: serviceSince(job),
    stepSince: job.stepStartedAt ?? null,
    blockers: [],
    blockersCheckedAt: null,
    estimate: maintenanceEstimate(history),
  };
}

/** Whether a restart or update request is running work rather than waiting on the owner. */
function restartInProgress(job: RestartJob): boolean {
  if (job.status === "pending") return restartOwnerState(job) === "in-progress";
  return job.status === "approved" || job.status === "running";
}

const TARGET_ORDER: MaintenanceTarget[] = ["host", "dev", "system"];

export function maintenanceProgress(input: MaintenanceProgressInput): MaintenanceProgress {
  const stale =
    input.lastUpdatedAt !== null &&
    input.now - Date.parse(input.lastUpdatedAt) > MAINTENANCE_STALE_MS;
  const staleSince = stale ? input.lastUpdatedAt : null;
  if (!input.unlocked) {
    // `queued` counts approved work and work another agent will approve; requests waiting on
    // the owner are `requested` and keep their own attention badge, so they are not counted.
    const running = input.summary?.running ?? 0;
    const queued = input.summary?.queued ?? 0;
    return {
      operations: [],
      locked: running + queued > 0 ? { running, queued } : null,
      staleSince,
    };
  }
  const jobs = input.jobs as readonly ProgressJob[];
  const services = input.serviceJobs as readonly ProgressService[];
  const operations = [
    ...jobs
      .filter(restartInProgress)
      .map((job) => restartOperation(job, jobs, input.visibleThread)),
    ...services
      .filter(
        (job) =>
          (job.status === "approved" || job.status === "running") &&
          jobOwnerState(job) === "in-progress",
      )
      .map((job) => serviceOperation(job, services)),
  ].sort(
    (left, right) =>
      TARGET_ORDER.indexOf(left.target) - TARGET_ORDER.indexOf(right.target) ||
      Date.parse(left.since?.at ?? "") - Date.parse(right.since?.at ?? ""),
  );
  return { operations, locked: null, staleSince };
}

/** The operation holding new messages to a daemon, if any: what the composer links to. */
export function messageHold(
  progress: MaintenanceProgress,
  target: "host" | "dev",
): MaintenanceOperation | null {
  return (
    progress.operations.find(
      (operation) => operation.target === target && operation.holdsMessages,
    ) ?? null
  );
}

// Words shared by every surface: plain English, as the rest of Settings > System is written.

const TARGET_NAMES: Record<MaintenanceTarget, string> = {
  host: "Host",
  dev: "Dev",
  system: "System services",
};

export function targetName(target: MaintenanceTarget): string {
  return TARGET_NAMES[target];
}

export function operationName(operation: Pick<MaintenanceOperation, "target" | "kind">): string {
  const target = TARGET_NAMES[operation.target];
  if (operation.kind === "update") return `${target} update`;
  if (operation.kind === "restart") return `${target} restart`;
  return `${target} maintenance`;
}

export function holdLine(operation: MaintenanceOperation): string | null {
  if (!operation.holdsMessages) return null;
  return `New messages to ${TARGET_NAMES[operation.target]} are held until it finishes.`;
}
