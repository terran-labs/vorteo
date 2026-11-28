import { z } from "zod";
import type { RestartJob } from "@getpaseo/protocol/execution-installation";

/**
 * Restart progress the coordinator records from its own transitions and its own clock, never from
 * a client. It lives in coordinator-private `restart-progress.json`, never in the shared restart
 * journal, so a rollback coordinator reads the journal unchanged and simply ignores this file.
 */
export const RESTART_PROGRESS_FILE = "restart-progress.json";
export const RESTART_PROGRESS_STEPS_MAX = 16;

/** Each step names what the coordinator can see; "restarting" is one opaque dispatch. */
export type RestartStep =
  | "awaiting-approval"
  | "waiting-to-start"
  | "preparing"
  | "waiting-for-idle"
  | "holding-turns"
  | "restarting"
  | "succeeded"
  | "failed"
  | "rejected";

/** Steps before the coordinator acts on a job; leaving them is the job's start. */
const BEFORE_START = new Set<RestartStep>(["awaiting-approval", "waiting-to-start"]);
const TERMINAL = new Set<RestartStep>(["succeeded", "failed", "rejected"]);

const iso = z.string().datetime();
const StepRecordSchema = z.strictObject({
  step: z.string().min(1).max(64),
  startedAt: iso,
  finishedAt: iso.nullable(),
});

const ProgressRecordSchema = z.strictObject({
  startedAt: iso.optional(),
  finishedAt: iso.optional(),
  steps: z.array(StepRecordSchema).max(RESTART_PROGRESS_STEPS_MAX),
  /**
   * The job revision whose hold the target acknowledged, when, and the deadline the coordinator
   * enforced for it. Kept after release so a finished job still shows how long its hold lasted.
   */
  hold: z
    .strictObject({ revision: z.string(), startedAt: iso, deadlineAt: iso.optional() })
    .optional(),
  holdReleasedAt: iso.optional(),
  /** Agent id to when the coordinator first saw it holding this job's current revision. */
  holders: z.strictObject({ revision: z.string(), since: z.record(z.string(), iso) }).optional(),
  notice: z
    .strictObject({
      state: z.enum(["pending-release", "delivered", "not-addressable"]),
      messageId: z.string().uuid(),
    })
    .optional(),
});
export type RestartProgressRecord = z.infer<typeof ProgressRecordSchema>;
export type RestartProgressMap = Record<string, RestartProgressRecord>;

export interface RestartProgressStore {
  read(): unknown;
  write(value: RestartProgressMap): void;
}

/**
 * The recorded history, or a fresh one. A missing, truncated or unreadable file must never stop the
 * coordinator or a restart: the caller logs the returned reason once and continues.
 */
export function loadRestartProgress(store: RestartProgressStore | undefined): {
  progress: Map<string, RestartProgressRecord>;
  discarded: string | null;
} {
  if (!store) return { progress: new Map(), discarded: null };
  try {
    const raw = store.read();
    if (raw === undefined) return { progress: new Map(), discarded: null };
    const parsed = z.record(z.string(), ProgressRecordSchema).safeParse(raw);
    if (!parsed.success) return { progress: new Map(), discarded: "unrecognized" };
    return { progress: new Map(Object.entries(parsed.data)), discarded: null };
  } catch {
    return { progress: new Map(), discarded: "unreadable" };
  }
}

/** The step a job is in, from the coordinator's own state for it. */
export function restartStepOf(job: RestartJob, holding: boolean): RestartStep {
  switch (job.status) {
    case "pending":
      return "awaiting-approval";
    case "running":
      return "restarting";
    case "succeeded":
    case "failed":
    case "rejected":
      return job.status;
    case "approved":
      if (job.updatePreparation === "preparing") return "preparing";
      if (job.finishCurrentTurns && holding && !job.holdReleased) return "holding-turns";
      if (job.whenIdle && !job.finishCurrentTurns) return "waiting-for-idle";
      return "waiting-to-start";
  }
}

function holdAcknowledged(job: RestartJob, record: RestartProgressRecord | undefined): boolean {
  return record?.hold?.revision === job.revision;
}

/** Records the job's current step; returns the same object when nothing changed. */
export function recordRestartStep(
  record: RestartProgressRecord | undefined,
  job: RestartJob,
  at: string,
): RestartProgressRecord {
  const step = restartStepOf(job, holdAcknowledged(job, record));
  const current = record ?? { steps: [] };
  const last = current.steps.at(-1);
  const released = job.holdReleased && current.hold && !current.holdReleasedAt;
  if (last?.step === step && !released) return current;
  let next: RestartProgressRecord = { ...current };
  if (last?.step !== step) {
    const closed = last ? [...current.steps.slice(0, -1), { ...last, finishedAt: at }] : [];
    const terminal = TERMINAL.has(step);
    const steps = [...closed, { step, startedAt: at, finishedAt: terminal ? at : null }];
    next = { ...next, steps: steps.slice(-RESTART_PROGRESS_STEPS_MAX) };
    if (!next.startedAt && !BEFORE_START.has(step) && !terminal) next.startedAt = at;
    if (terminal && !next.finishedAt) next.finishedAt = at;
  }
  if (released) next.holdReleasedAt = at;
  return next;
}

/** The target acknowledged this revision's hold: admission is closed. Recorded once per revision. */
export function recordHoldStart(
  record: RestartProgressRecord | undefined,
  job: RestartJob,
  at: string,
): RestartProgressRecord {
  const current = record ?? { steps: [] };
  if (current.hold?.revision === job.revision) return current;
  return { ...current, hold: { revision: job.revision, startedAt: at }, holdReleasedAt: undefined };
}

/** Records the deadline the coordinator enforces for this revision's hold, the first time it is seen. */
export function recordHoldDeadline(
  record: RestartProgressRecord | undefined,
  job: RestartJob,
  deadlineAt: string,
  at: string,
): RestartProgressRecord {
  const current = record ?? { steps: [] };
  const hold = current.hold?.revision === job.revision ? current.hold : undefined;
  if (hold?.deadlineAt) return current;
  return {
    ...current,
    hold: { revision: job.revision, startedAt: hold?.startedAt ?? at, deadlineAt },
  };
}

/** Keeps the first sighting of each agent still holding this revision; forgets those gone. */
export function recordHolders(
  record: RestartProgressRecord | undefined,
  job: RestartJob,
  agentIds: readonly string[],
  at: string,
): RestartProgressRecord {
  const current = record ?? { steps: [] };
  const known = current.holders?.revision === job.revision ? current.holders.since : {};
  const since: Record<string, string> = {};
  for (const id of agentIds) since[id] = known[id] ?? at;
  const unchanged =
    current.holders?.revision === job.revision &&
    JSON.stringify(Object.keys(since).sort()) === JSON.stringify(Object.keys(known).sort());
  return unchanged ? current : { ...current, holders: { revision: job.revision, since } };
}

export interface RestartProgressReply {
  startedAt?: string;
  step?: string;
  stepStartedAt?: string;
  steps?: RestartProgressRecord["steps"];
  holdStartedAt?: string;
  holdDeadlineAt?: string;
  holdReleasedAt?: string;
  finishedAt?: string;
  requesterNotice?: "pending-release" | "delivered";
}

/** The reply-only fields for a capable client. Absent values stay absent. */
export function restartProgressReply(
  job: RestartJob,
  record: RestartProgressRecord | undefined,
): RestartProgressReply {
  if (!record) return {};
  const last = record.steps.at(-1);
  const hold = holdAcknowledged(job, record) ? record.hold : undefined;
  const notice = record.notice?.state;
  return {
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(last ? { step: last.step, stepStartedAt: last.startedAt, steps: record.steps } : {}),
    ...(hold ? { holdStartedAt: hold.startedAt } : {}),
    ...(hold?.deadlineAt ? { holdDeadlineAt: hold.deadlineAt } : {}),
    ...(hold && record.holdReleasedAt ? { holdReleasedAt: record.holdReleasedAt } : {}),
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(notice === "pending-release" || notice === "delivered" ? { requesterNotice: notice } : {}),
  };
}

/** Adds each holder's first sighting to a reply's impact, for agents the coordinator saw. */
export function withHolderSince(
  impact: RestartJob["impact"],
  job: RestartJob,
  record: RestartProgressRecord | undefined,
): RestartJob["impact"] {
  if (!impact || record?.holders?.revision !== job.revision) return impact;
  const since = record.holders.since;
  const agents: NonNullable<RestartJob["impact"]>["agents"] = [];
  for (const agent of impact.agents) {
    const waitingSince = since[agent.id];
    agents.push(waitingSince ? { ...agent, waitingSince } : agent);
  }
  return { ...impact, agents };
}
