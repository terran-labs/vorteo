import type { StoredAgentRecord } from "../agent-storage.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { PROJECT_FACTORY_ROLE_LABEL } from "../../factory/project/roles.js";

/**
 * Each review waits this long after the thread's last activity or review, then the ladder stops.
 * All three land inside the one-hour prompt cache and before idle runtime cleanup, so a review
 * rereads a warm cache instead of rebuilding the whole conversation. Hourly reviews landed just
 * after the cache expired and cost the most expensive rate every time.
 */
export const BLOCKED_REVIEW_DELAYS_MS = [5, 15, 30].map((minutes) => minutes * 60_000);
/**
 * A slot missed by more than this is forfeited, never run late. A late review rebuilds a cold
 * cache: turning the setting on once reviewed threads blocked for days, and one of them wrote
 * 612k cache tokens to answer "nothing has changed". The longest delay plus this grace stays
 * inside the one-hour cache.
 */
export const BLOCKED_REVIEW_SLOT_GRACE_MS = 15 * 60_000;
/** Insurance against a thread that notifications keep restarting, and against a burst of stops. */
export const BLOCKED_REVIEW_DAILY_THREAD_CAP = 6;
export const BLOCKED_REVIEW_HOURLY_INSTALLATION_CAP = 12;
// A review's own prompt arrives seconds after its claim; a prompt later than this is real activity.
const REVIEW_PROMPT_SLACK_MS = 2 * 60_000;

/**
 * The Factory project a role thread (Foreman, Builds, Triage and the rest) belongs to. While the
 * owner has that project paused, a review can only answer "still paused", so the scan skips the
 * thread. Issue leads, workers and reviewers are subagents and are never reviewed anyway.
 */
export function factoryProjectOf(record: StoredAgentRecord): string | null {
  const role = record.labels[PROJECT_FACTORY_ROLE_LABEL];
  const separator = role?.lastIndexOf(":") ?? -1;
  return role && separator > 0 ? role.slice(0, separator) : null;
}

/**
 * Unfinished items a review could move: blocked ones, and in-progress ones left behind when the
 * thread stopped. Items an open question covers are skipped because the answer arrives as a
 * message. Items in review already wait on the owner.
 */
export function reviewableTasks(
  record: StoredAgentRecord,
): NonNullable<StoredAgentRecord["tasks"]> {
  const awaitingOwner = new Set(
    (record.questions ?? [])
      .filter((question) => question.status === "open")
      .flatMap((question) => question.blocks ?? []),
  );
  return (record.tasks ?? []).filter(
    (task) =>
      !task.completed &&
      (task.status === "blocked" || task.status === "in_progress") &&
      !(task.id && awaitingOwner.has(task.id)),
  );
}

/**
 * True when every reviewable item is merely in progress. Such a thread is reviewed only when
 * nothing else will wake it: live background work or a running subagent reports back by itself.
 */
export function onlyInProgressWork(record: StoredAgentRecord): boolean {
  if (record.blockedGoalReviewNeeded === true) return false;
  const tasks = reviewableTasks(record);
  return tasks.length > 0 && tasks.every((task) => task.status === "in_progress");
}

/**
 * What a review can change. An unchanged fingerprint after a review ends the ladder. The goal
 * discovery flag is left out: reading the goal for admission can settle it without any progress.
 */
export function reviewFingerprint(record: StoredAgentRecord): string {
  return (record.tasks ?? [])
    .filter((task) => !task.completed)
    .map((task) => {
      const passed = (task.checks ?? []).filter((check) => check.done).length;
      return `${task.id ?? task.text}:${task.status ?? ""}:${passed}`;
    })
    .sort()
    .join("|");
}

/** This is an ordinary thread review, never a second governor or worker scheduler. */
export function hasReviewableBlockedWork(record: StoredAgentRecord): boolean {
  const externallyOwned = record.owner || record.config?.controllerExecutionId;
  // A thread waiting for a usage limit to reset is resumed by UsageLimitResumeService instead.
  const usageLimited = record.config?.usageLimitHold && !record.config.usageLimitHold.releasedAt;
  const held =
    record.archivedAt ||
    record.internal ||
    record.queueGoalHold ||
    record.config?.quotaPausedAt ||
    usageLimited;
  const delegated = record.labels[PARENT_AGENT_ID_LABEL];
  if (externallyOwned || held || delegated || !record.persistence?.sessionId) return false;
  if (record.blockedGoalReviewNeeded === true) return true;
  return reviewableTasks(record).length > 0;
}

function parseTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reviews spent in the current blocked stretch; a real prompt after the last review starts a new one. */
export function blockedReviewsUsed(record: StoredAgentRecord): number {
  const lastReview = parseTime(record.lastBlockedReviewAt);
  if (lastReview === undefined) return 0;
  const lastPrompt = parseTime(record.lastUserMessageAt);
  if (lastPrompt !== undefined && lastPrompt > lastReview + REVIEW_PROMPT_SLACK_MS) return 0;
  return record.blockedReviewCount ?? 0;
}

export function blockedReviewDue(record: StoredAgentRecord, now: number): boolean {
  if (!hasReviewableBlockedWork(record)) return false;
  const timestamps = [record.createdAt, record.lastActivityAt, record.lastBlockedReviewAt];
  const parsed = timestamps.filter((value): value is string => value !== undefined).map(Date.parse);
  if (!parsed.every(Number.isFinite)) return false;
  const delay = BLOCKED_REVIEW_DELAYS_MS[blockedReviewsUsed(record)];
  // The ladder is spent for this stretch; only a real prompt starts another.
  if (delay === undefined) return false;
  const waited = now - Math.max(...parsed);
  return waited >= delay && waited <= delay + BLOCKED_REVIEW_SLOT_GRACE_MS;
}

export const BLOCKED_REVIEW_PROMPT =
  "Automatic stall review. This thread stopped with unfinished checklist items and nothing set to wake it. " +
  "Check each blocked or in-progress item against current evidence and act on any that is ready " +
  "(a green pull request, a finished job, an answered question), within the owner's existing authorization. " +
  "For an item still waiting: if a command can detect the change, start a background watcher that wakes " +
  "you; if it waits on the owner, set it to review with one line saying what they must do. Update the " +
  "checklist to match what you found. If nothing changed, say so in one sentence and stop: an unchanged " +
  "checklist ends these reviews until the next message. Do not repeat requests already awaiting the owner, " +
  "create workers, override a pause, raise budgets, or bypass queue, restart, account or permission holds. " +
  "This review grants no new authority.";
