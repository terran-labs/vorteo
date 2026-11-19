import type { AgentTaskItem, AgentTimelineItem } from "./agent-types.js";

export { ChecklistMutationSchema, type ChecklistMutation } from "./task-checklist.js";
import { z } from "zod";
import type { ChecklistMutation, ChecklistWakeCondition } from "./task-checklist.js";

export function mergeTaskMetadata(
  current: AgentTaskItem["metadata"],
  patch: NonNullable<AgentTaskItem["metadata"]>,
): NonNullable<AgentTaskItem["metadata"]> {
  const merged = { ...current, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
  }
  return merged;
}

function addDependents(items: AgentTaskItem[], id: string, dependents: string[]): AgentTaskItem[] {
  const next = [...items];
  for (const dependent of new Set(dependents)) {
    const index = next.findIndex((item) => item.id === dependent && item.source === "vorteo");
    if (index < 0)
      throw new ChecklistError("dependency", `Vorteo dependency ${dependent} does not exist.`);
    const task = next[index];
    next[index] = { ...task, blockedBy: [...new Set([...(task.blockedBy ?? []), id])] };
  }
  return next;
}

export function mergeProviderChecklist(
  provider: readonly AgentTaskItem[],
  current: readonly AgentTaskItem[],
): AgentTaskItem[] {
  return [
    ...provider.filter((item) => item.source !== "vorteo"),
    ...current.filter((item) => item.source === "vorteo"),
  ];
}

export class ChecklistError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "invalid"
      | "not_found"
      | "provider_owned"
      | "duplicate"
      | "dependency"
      | "limit"
      | "order",
    message: string,
  ) {
    super(message);
    this.name = "ChecklistError";
  }
}

/** Reject invalid targets after structural parsing, without involving transport codegen. */
function validateWakeCondition(condition: ChecklistWakeCondition): void {
  if (condition.kind === "deadline") {
    if (!z.iso.datetime({ offset: true }).safeParse(condition.at).success) {
      throw new ChecklistError(
        "invalid",
        "Wake deadline must be an ISO timestamp with a timezone.",
      );
    }
    return;
  }
  const validOwner = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(condition.owner);
  const validRepository = /^[a-zA-Z0-9_.-]{1,100}$/.test(condition.repository);
  const dotRepository = condition.repository === "." || condition.repository === "..";
  if (!validOwner || !validRepository || dotRepository) {
    throw new ChecklistError(
      "invalid",
      "Wake target must name a GitHub owner and repository, not a URL.",
    );
  }
  const identifiers =
    condition.kind === "github_workflow_run"
      ? [condition.runId, condition.attempt]
      : [condition.number];
  if (identifiers.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new ChecklistError("invalid", "Wake target numbers must be positive safe integers.");
  }
  if (condition.kind !== "github_required_checks") return;
  if (!/^[a-fA-F0-9]{40}$/.test(condition.headSha)) {
    throw new ChecklistError("invalid", "Required checks must pin a full PR head SHA.");
  }
  const invalidChecks =
    condition.checks.length === 0 ||
    condition.checks.length > 100 ||
    condition.checks.some((name) => !name.trim() || name.length > 300) ||
    new Set(condition.checks).size !== condition.checks.length;
  if (invalidChecks) {
    throw new ChecklistError("invalid", "Name between 1 and 100 distinct required checks.");
  }
}

function validateDependencies(items: readonly AgentTaskItem[]): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id))
      throw new ChecklistError("dependency", "Task dependencies must not form a cycle.");
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new ChecklistError("dependency", `Dependency ${id} does not exist.`);
    visiting.add(id);
    for (const dependency of task.blockedBy ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of items) {
    if (task.id) visit(task.id);
  }
}

/** Provider snapshots are read-only here; their provider remains their sole writer. */
/** Unfinished work never claims more than this, so "basically done" stays visibly unfinished. */
export const MAX_UNFINISHED_PROGRESS = 90;

/**
 * Settle an item's progress from its own evidence. Completed work is 100. Passed checks decide
 * progress when the item has any; otherwise an estimate is rounded to 5 points and capped until
 * the item is completed. Rounding also absorbs small updates that would only flicker the display.
 */
export function normalizeTaskProgress(task: AgentTaskItem): AgentTaskItem {
  // Completed already reads as 100 everywhere; only items that track progress carry the field.
  const checks = task.checks ?? [];
  if (task.completed) {
    const tracked = task.progress !== undefined || checks.length > 0;
    return !tracked || task.progress === 100 ? task : { ...task, progress: 100 };
  }
  const raw =
    checks.length > 0
      ? (checks.filter((check) => check.done).length / checks.length) * 100
      : task.progress;
  if (raw === undefined) return task;
  const progress = Math.min(MAX_UNFINISHED_PROGRESS, Math.max(0, Math.round(raw / 5) * 5));
  return task.progress === progress ? task : { ...task, progress };
}

/**
 * Apps from before checklist progress drop `progress` and `checks` when they parse an item, so
 * their expectedTask never contains them. Compare those fields only when the client sent them;
 * every other field keeps exact optimistic concurrency. Agents own these fields; editors never
 * change them.
 */
function comparableTask(expected: AgentTaskItem, current: AgentTaskItem): AgentTaskItem {
  const comparable = { ...current };
  if (!("progress" in expected)) delete comparable.progress;
  if (!("checks" in expected)) delete comparable.checks;
  return comparable;
}

export function mutateChecklist(
  items: readonly AgentTaskItem[],
  mutation: ChecklistMutation,
  platform: { createId: () => string; equal: (left: unknown, right: unknown) => boolean },
): AgentTaskItem[] {
  if ("text" in mutation && mutation.text !== undefined) {
    const text = mutation.text.trim();
    if (!text) throw new ChecklistError("invalid", "Task text must not be blank.");
    mutation = { ...mutation, text };
  }
  if (mutation.operation === "create") {
    const {
      operation: _operation,
      id = platform.createId(),
      progress,
      wakeCondition,
      ...fields
    } = mutation;
    if (items.some((item) => item.id === id)) {
      throw new ChecklistError("duplicate", `Task ${id} already exists. Read it before retrying.`);
    }
    if (items.length >= 500)
      throw new ChecklistError("limit", "A checklist can contain at most 500 tasks.");
    const created = applyWakeCondition(
      {
        ...fields,
        ...(progress === null || progress === undefined ? {} : { progress }),
        id,
        source: "vorteo",
        status: "pending",
        completed: false,
      },
      wakeCondition,
    );
    const next: AgentTaskItem[] = [...items, normalizeTaskProgress(created)];
    validateDependencies(next.filter((item) => item.source === "vorteo"));
    return next;
  }
  if (mutation.operation === "reorder") {
    const managed = items.filter((item) => item.source === "vorteo");
    const byId = new Map(managed.map((item) => [item.id, item]));
    const unique = new Set(mutation.ids);
    const completeOrder = unique.size === managed.length && mutation.ids.length === managed.length;
    if (!completeOrder)
      throw new ChecklistError("order", "Supply every Vorteo task ID exactly once.");
    const ordered = mutation.ids.map((id) => {
      const item = byId.get(id);
      if (!item) throw new ChecklistError("order", `Unknown Vorteo task ${id}.`);
      return item;
    });
    return [...items.filter((item) => item.source !== "vorteo"), ...ordered];
  }
  const current =
    items.find((item) => item.id === mutation.id && item.source === "vorteo") ??
    items.find((item) => item.id === mutation.id);
  if (!current) throw new ChecklistError("not_found", `Task ${mutation.id} does not exist.`);
  if (current.source !== "vorteo") {
    throw new ChecklistError(
      "provider_owned",
      "Use the native provider task tool to edit this provider-owned task.",
    );
  }
  if (
    mutation.expectedTask &&
    !platform.equal(mutation.expectedTask, comparableTask(mutation.expectedTask, current))
  ) {
    throw new ChecklistError(
      "conflict",
      "This task changed while you were editing it. Close and reopen to review the current task.",
    );
  }
  if (mutation.operation === "delete") {
    return items
      .filter((item) => item !== current)
      .map((item) => {
        if (item.source !== "vorteo" || !item.blockedBy?.includes(mutation.id)) return item;
        return Object.assign({}, item, {
          blockedBy: item.blockedBy.filter((id) => id !== mutation.id),
        });
      });
  }
  return updateTask(items, current, mutation);
}

/** Omission preserves the condition; null removes it from stored task data. */
function applyWakeCondition(
  task: AgentTaskItem,
  wakeCondition: ChecklistWakeCondition | null | undefined,
): AgentTaskItem {
  if (wakeCondition === undefined) return task;
  const updated = { ...task };
  if (wakeCondition === null) delete updated.wakeCondition;
  else {
    validateWakeCondition(wakeCondition);
    updated.wakeCondition = wakeCondition;
  }
  return updated;
}

/** Apply an explicit progress value or clearing, and drop derived progress when checks are emptied. */
function applyProgressFields(
  current: AgentTaskItem,
  updated: AgentTaskItem,
  progress: number | null | undefined,
  checks: AgentTaskItem["checks"],
): AgentTaskItem {
  const next = { ...updated };
  if (progress === null) delete next.progress;
  else if (progress !== undefined) next.progress = progress;
  // Emptying the checks also drops the value they derived, unless a new estimate came with it.
  if (checks !== undefined && checks.length === 0) {
    delete next.checks;
    if (progress === undefined && current.checks?.length) delete next.progress;
  }
  return next;
}

/** Completion requires every acceptance check to pass. Older completed items stay editable. */
function assertChecksPassedForCompletion(
  updated: AgentTaskItem,
  fields: { status?: AgentTaskItem["status"]; checks?: AgentTaskItem["checks"] },
): void {
  const completingOrRechecking = fields.status === "completed" || fields.checks !== undefined;
  if (completingOrRechecking && updated.completed && updated.checks?.some((check) => !check.done)) {
    throw new ChecklistError(
      "invalid",
      "Mark every acceptance check done before completing this task, or update its checks.",
    );
  }
}

function updateTask(
  items: readonly AgentTaskItem[],
  current: AgentTaskItem,
  mutation: Extract<ChecklistMutation, { operation: "update" }>,
): AgentTaskItem[] {
  const {
    operation: _operation,
    id,
    expectedTask: _expectedTask,
    addBlocks,
    addBlockedBy,
    progress,
    wakeCondition,
    ...fields
  } = mutation;
  const status = fields.status ?? current.status ?? "pending";
  let updated: AgentTaskItem = { ...current, ...fields, status, completed: status === "completed" };
  updated = applyWakeCondition(updated, wakeCondition);
  updated = applyProgressFields(current, updated, progress, fields.checks);
  assertChecksPassedForCompletion(updated, fields);
  if (fields.metadata !== undefined)
    updated.metadata = mergeTaskMetadata(current.metadata, fields.metadata);
  if (addBlockedBy !== undefined)
    updated.blockedBy = [...new Set([...(updated.blockedBy ?? []), ...addBlockedBy])];
  updated = normalizeTaskProgress(updated);
  const replaced = items.map((item) => (item === current ? updated : item));
  const next = addDependents(replaced, id, addBlocks ?? []);
  validateDependencies(next.filter((item) => item.source === "vorteo"));
  const startingOrCompleting = fields.status === "in_progress" || fields.status === "completed";
  const incompleteDependency = updated.blockedBy?.find(
    (dependency) =>
      !next.find((item) => item.id === dependency && item.source === "vorteo")?.completed,
  );
  if (startingOrCompleting && incompleteDependency) {
    throw new ChecklistError(
      "dependency",
      `Complete dependency ${incompleteDependency} before starting or completing this task.`,
    );
  }
  return next;
}

export function managedChecklist(items: readonly AgentTaskItem[] = []): AgentTaskItem[] {
  return items.filter((item) => item.source === "vorteo");
}

export function mergeProviderChecklistEvent(
  item: AgentTimelineItem,
  current: readonly AgentTaskItem[] = [],
): AgentTimelineItem {
  if (item.type !== "todo") return item;
  return { type: "todo", items: mergeProviderChecklist(item.items, current) };
}
