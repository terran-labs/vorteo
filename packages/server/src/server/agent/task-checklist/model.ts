import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";
import { ChecklistError } from "@getpaseo/protocol/checklist-model";
import { mutateChecklist as mutateSharedChecklist } from "@getpaseo/protocol/checklist-model";

export * from "@getpaseo/protocol/checklist-model";

/** Provider tasks may appear anywhere in a combined checklist and may share IDs. */
export function findCreatedChecklistTask(
  previous: readonly AgentTaskItem[],
  next: readonly AgentTaskItem[],
): AgentTaskItem {
  const previousIds = new Set(
    previous.filter((task) => task.source === "vorteo").map((task) => task.id),
  );
  const created = next.find((task) => task.source === "vorteo" && !previousIds.has(task.id));
  if (!created) throw new ChecklistError("not_found", "Created Vorteo task was not returned.");
  return created;
}

/** Keep native ID generation and equality semantics for persisted server tasks. */
export function mutateChecklist(
  items: readonly AgentTaskItem[],
  mutation: ChecklistMutation,
): AgentTaskItem[] {
  const next = mutateSharedChecklist(items, mutation, {
    createId: randomUUID,
    equal: isDeepStrictEqual,
  });
  // Validate merged metadata, while leaving untouched legacy records editable.
  if ((mutation.operation === "create" || mutation.operation === "update") && mutation.metadata) {
    const task =
      mutation.operation === "create"
        ? findCreatedChecklistTask(items, next)
        : next.find((item) => item.id === mutation.id && item.source === "vorteo");
    if (Buffer.byteLength(JSON.stringify(task?.metadata ?? {}), "utf8") > 8192) {
      throw new ChecklistError(
        "limit",
        "Task metadata exceeds 8 KiB serialized. Put large records in the journal's machineContext instead.",
      );
    }
  }
  return next;
}

/** The most mutations one update_checklist call may apply together. */
export const MAX_CHECKLIST_BATCH = 20;

/**
 * One or several checklist mutations. A single mutation keeps its original request and error
 * shape; an array is a batch that applies in order and commits only if every mutation succeeds.
 */
export type ChecklistMutationInput = ChecklistMutation | readonly ChecklistMutation[];

export function isChecklistBatch(
  input: ChecklistMutationInput,
): input is readonly ChecklistMutation[] {
  return Array.isArray(input);
}

/**
 * Name the failing mutation of a batch so the agent can correct it. The batch is all or nothing,
 * so the message also says that nothing was applied. Single mutations never reach this.
 */
export function batchChecklistError(
  error: unknown,
  index: number,
  batch: readonly ChecklistMutation[],
): unknown {
  if (!(error instanceof ChecklistError)) return error;
  const mutation = batch[index];
  // Creates may carry an ID the agent never chose, so name them by their text.
  let target = "";
  if (mutation.operation === "create") target = ` "${mutation.text}"`;
  else if (mutation.operation !== "reorder") target = ` ${mutation.id}`;
  return new ChecklistError(
    error.code,
    `Mutation ${index + 1} of ${batch.length} (${mutation.operation}${target}) failed, so none were applied: ${error.message}`,
  );
}
