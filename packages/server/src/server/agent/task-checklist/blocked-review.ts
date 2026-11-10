import type { StoredAgentRecord } from "../agent-storage.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

/**
 * Each review waits this long after the thread's last activity or review, then the ladder stops.
 * All three land inside the one-hour prompt cache and before idle runtime cleanup, so a review
 * rereads a warm cache instead of rebuilding the whole conversation. Hourly reviews landed just
 * after the cache expired and cost the most expensive rate every time.
 */
export const BLOCKED_REVIEW_DELAYS_MS = [5, 15, 30].map((minutes) => minutes * 60_000);
// A review's own prompt arrives seconds after its claim; a prompt later than this is real activity.
const REVIEW_PROMPT_SLACK_MS = 2 * 60_000;

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
  // An answer to an open question already arrives as a message, so its blockers need no review.
  const awaitingOwner = new Set(
    (record.questions ?? [])
      .filter((question) => question.status === "open")
      .flatMap((question) => question.blocks ?? []),
  );
  return (record.tasks ?? []).some(
    (task) =>
      !task.completed && task.status === "blocked" && !(task.id && awaitingOwner.has(task.id)),
  );
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

export function isFinalBlockedReview(record: StoredAgentRecord): boolean {
  return blockedReviewsUsed(record) === BLOCKED_REVIEW_DELAYS_MS.length - 1;
}

export function blockedReviewDue(record: StoredAgentRecord, now: number): boolean {
  if (!hasReviewableBlockedWork(record)) return false;
  const timestamps = [record.createdAt, record.lastActivityAt, record.lastBlockedReviewAt];
  const parsed = timestamps.filter((value): value is string => value !== undefined).map(Date.parse);
  if (!parsed.every(Number.isFinite)) return false;
  const delay = BLOCKED_REVIEW_DELAYS_MS[blockedReviewsUsed(record)];
  // The ladder is spent for this stretch; only a real prompt starts another.
  if (delay === undefined) return false;
  return now - Math.max(...parsed) >= delay;
}

export const BLOCKED_REVIEW_PROMPT =
  "Periodic blocked-work review. Read your current checklist, goal and recent conversation, then recheck the concrete " +
  "conditions that blocked your work. Use current evidence. If a blocker has cleared, update the " +
  "task and continue the owner's authorized work; edit or resume your own blocked goal when appropriate. " +
  "Reconcile every unfinished checklist item. A remaining blocker pauses only dependent work: record its " +
  "reason and the next condition to check, then continue any independent authorized implementation, testing, " +
  "review or preparation. End as blocked only when every remaining item is blocked, awaiting an external " +
  "result, or explicitly paused. Preserve completion notifications for pending work. " +
  "Do not repeat requests already awaiting the owner, create workers, override an owner pause, " +
  "raise budgets, or bypass queue, restart, account or permission holds. This review grants no new authority.";

/** The last review of a stretch asks the agent to leave blockers the owner can act on. */
export const FINAL_BLOCKED_REVIEW_NOTE =
  " This is the last automatic review until someone sends this thread a message. For each item " +
  "still blocked, make sure its description tells the owner what must happen and how to verify it.";
