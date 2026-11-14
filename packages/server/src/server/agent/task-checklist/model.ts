import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import type { ChecklistMutation } from "@getpaseo/protocol/task-checklist";
import { ChecklistError } from "@getpaseo/protocol/checklist-model";
import { mutateChecklist as mutateSharedChecklist } from "@getpaseo/protocol/checklist-model";

export * from "@getpaseo/protocol/checklist-model";

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
        ? next[next.length - 1]
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
