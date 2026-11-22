import type { AgentTaskItem } from "@getpaseo/protocol/agent-types";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentManager } from "../agent-manager.js";
import type { PaseoToolDefinition, PaseoToolResult } from "../tools/types.js";
import {
  ChecklistMutationSchema,
  ChecklistError,
  MAX_CHECKLIST_BATCH,
  findCreatedChecklistTask,
  type ChecklistMutation,
} from "./model.js";

const ReadChecklistSchema = z
  .object({ id: z.string().optional(), source: z.enum(["vorteo", "provider"]).optional() })
  .strict();
// `mutation` is the original single-change form; `mutations` is an ordered all-or-nothing batch.
// Exactly one is required, and null counts as absent because some providers send null for an
// omitted optional field. The handler checks that, so a single-mutation call reports the same
// validation errors it always has.
//
// `mutations` is declared loosely on purpose. Repeating the mutation union here doubled the JSON
// schema every provider loads with the tool list. The handler validates each item against the
// same strict schema `mutation` uses before anything is applied.
const UpdateChecklistSchema = z
  .object({
    mutation: ChecklistMutationSchema.nullable().optional(),
    mutations: z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .max(MAX_CHECKLIST_BATCH)
      .nullable()
      .optional()
      .describe("Each item has the same shape as mutation."),
  })
  .strict();

/** Validate every batch item strictly before any is applied, naming the first invalid one. */
function parseBatch(items: Record<string, unknown>[]): ChecklistMutation[] {
  return items.map((item, index) => {
    const parsed = ChecklistMutationSchema.safeParse(item);
    if (parsed.success) return parsed.data;
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "mutation"}: ${issue.message}`)
      .join("; ");
    throw new ChecklistError(
      "invalid",
      `Mutation ${index + 1} of ${items.length} is invalid, so none were applied: ${issues}`,
    );
  });
}

function result(value: unknown): PaseoToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

// Keep routine tool results bounded even when legacy tasks contain large metadata.
function compactTask(task: AgentTaskItem) {
  const { id, text, owner, blockedBy, progress, source, wakeCondition } = task;
  const status = task.status ?? (task.completed ? "completed" : "pending");
  const description = task.description?.slice(0, 200);
  const checks = task.checks
    ? { total: task.checks.length, done: task.checks.filter((check) => check.done).length }
    : undefined;
  return {
    id,
    text,
    status,
    source,
    owner,
    blockedBy,
    progress,
    checks,
    description,
    wakeCondition,
  };
}

/**
 * Apply a batch and report it once: the affected compact tasks in checklist order, any deleted
 * IDs, the final order when the batch reordered, and one summary.
 */
async function applyBatch(
  manager: Pick<AgentManager, "mutateChecklist">,
  callerAgentId: string,
  input: ChecklistMutation[],
) {
  // Fix generated IDs up front, exactly as the model would, so created tasks can be reported.
  const mutations = input.map((mutation) =>
    mutation.operation === "create" && mutation.id === undefined
      ? { ...mutation, id: randomUUID() }
      : mutation,
  );
  const tasks = await manager.mutateChecklist(callerAgentId, mutations);
  const managed = tasks.filter((task) => task.source === "vorteo");
  const remaining = new Set(managed.map((task) => task.id));
  const affected = new Set<string>();
  const deleted: string[] = [];
  for (const mutation of mutations) {
    if (mutation.operation === "reorder") continue;
    if (mutation.operation === "delete") {
      if (!remaining.has(mutation.id) && !deleted.includes(mutation.id)) deleted.push(mutation.id);
      continue;
    }
    if (mutation.id !== undefined) affected.add(mutation.id);
    if (mutation.operation === "update")
      for (const id of mutation.addBlocks ?? []) affected.add(id);
  }
  const reordered = mutations.some((mutation) => mutation.operation === "reorder");
  return {
    tasks: managed.filter((task) => affected.has(task.id ?? "")).map(compactTask),
    ...(deleted.length > 0 ? { deleted } : {}),
    ...(reordered ? { ids: managed.map((task) => task.id) } : {}),
    summary: summarize(tasks),
  };
}

function summarize(tasks: AgentTaskItem[]) {
  const counts = { pending: 0, in_progress: 0, review: 0, blocked: 0, completed: 0 };
  for (const task of tasks) counts[task.status ?? (task.completed ? "completed" : "pending")]++;
  return counts;
}

export function createChecklistTools(
  manager: Pick<AgentManager, "readChecklist" | "mutateChecklist">,
  callerAgentId?: string,
): PaseoToolDefinition[] {
  return [
    {
      name: "get_checklist",
      title: "Read your thread checklist",
      description:
        "Read this thread's persistent checklist, including native provider tasks. Omit id for compact tasks with descriptions limited to 200 characters, check counts and no metadata; supply id for full task details. A matching Vorteo ID takes precedence; supply source=provider to inspect a native task with the same ID. Completed tasks remain visible. blockedBy lists prerequisite IDs; owner is an assignment label, not permission to launch or message another agent.",
      inputSchema: ReadChecklistSchema,
      handler: async (input) => {
        if (!callerAgentId?.trim()) {
          throw new Error("An agent-scoped caller identity is required");
        }
        const { id, source } = ReadChecklistSchema.parse(input);
        const tasks = manager
          .readChecklist(callerAgentId)
          .filter((item) => source === undefined || (item.source ?? "provider") === source);
        if (id === undefined) return result({ tasks: tasks.map(compactTask) });
        const task =
          tasks.find((item) => item.id === id && item.source === "vorteo") ??
          tasks.find((item) => item.id === id);
        if (!task) throw new ChecklistError("not_found", `Task ${id} does not exist.`);
        const blocks = tasks
          .filter(
            (item) =>
              (item.source ?? "provider") === (task.source ?? "provider") &&
              item.blockedBy?.includes(id),
          )
          .map((item) => item.id);
        return result({ task, blocks });
      },
    },
    {
      name: "update_checklist",
      title: "Update your thread checklist",
      description:
        "Create, update, delete, or reorder persistent Vorteo tasks in this thread. Send mutation, or mutations (1 to 20) to apply in order as one all-or-nothing write; a failure applies none and names it. Give a create an id to reference it later in the batch. Returns only affected compact tasks (no metadata), the deleted id(s), or reordered ids, plus summary counts by status. Metadata is limited to 8 KiB serialized per task; put larger records in the journal machineContext. These updates populate the bottom checklist card and workspace completion donut. Create pending tasks with text and description containing completion criteria. Write task titles, descriptions, activeForm and blocker explanations for the owner in concise, plain language. Explain what cannot proceed, why and what needs to happen next using recognizable names. Keep IDs, hashes, raw paths, tool names and logs in metadata, not visible prose. Use descriptive link labels for necessary actions or evidence. Set status=in_progress before starting authorized work and completed only after its acceptance checks pass. Keep future work pending. Agents may set or clear status=blocked at their discretion, with or without blockedBy dependencies. Record the concrete blocker and the condition that would clear it in description; the blocked badge displays that explanation. Reassess blocked tasks on continuation and when dependencies change; return to pending or in_progress when ready. Never override an explicit owner pause or a restart hold. Review means waiting for review or approval and remains incomplete. Keep its description short, for example: Waiting for your approval. Blocked is incomplete. If switching away from actionable work, set pending. Reconcile stale states when resuming; normally keep one active item per agent. Use update to set pending/in_progress/review/blocked/completed, reopen a task, or change its blockedBy, owner, metadata, or text. blockedBy replaces prerequisites; addBlockedBy and addBlocks add dependency edges. Metadata merges by key; a null value deletes a key. Complete prerequisites before starting dependent tasks. Empty owner clears assignment. Delete removes the task and dependency references; reorder requires every Vorteo task ID exactly once. Initially list tasks in planned execution order. Keep completed items first in completion order, then in_progress items, then review, pending and blocked items in intended execution order. Reorder at status changes. Attach wakeCondition to blocked work for a deadline or explicit GitHub prerequisite; null clears it. A PR closed condition accepts closure or merge; merged requires a merge. Closing without merge makes a merged prerequisite unavailable and restores existing opt-in review eligibility. Use finish subscriptions for another agent and Review for owner decisions. Provider-owned tasks must be edited through their native tool. Read before retries after an error. Use checks (up to 20 {text, done}) for verifiable acceptance criteria; checks replaces the whole list, so send every check each time. Passed checks set progress. Without checks, progress is a 0 to 100 estimate, rounded to 5 and capped at 90 until completed. Completion is refused while any check is undone; send progress null to stop tracking it. Checklist updates do not authorize implementation, delegation, deployment, or restarts.",
      inputSchema: UpdateChecklistSchema,
      handler: async (input) => {
        if (!callerAgentId?.trim()) {
          throw new Error("An agent-scoped caller identity is required");
        }
        const parsed = UpdateChecklistSchema.parse(input);
        const mutation = parsed.mutation ?? undefined;
        const mutations = parsed.mutations ?? undefined;
        const exactlyOne = "Supply exactly one of mutation or mutations.";
        if (mutation !== undefined && mutations !== undefined) {
          throw new ChecklistError("invalid", exactlyOne);
        }
        if (mutations !== undefined) {
          return result(await applyBatch(manager, callerAgentId, parseBatch(mutations)));
        }
        if (mutation === undefined) throw new ChecklistError("invalid", exactlyOne);
        const previous =
          mutation.operation === "create" ? manager.readChecklist(callerAgentId) : [];
        const tasks = await manager.mutateChecklist(callerAgentId, mutation);
        const summary = summarize(tasks);
        if (mutation.operation === "delete") return result({ id: mutation.id, summary });
        if (mutation.operation === "reorder") return result({ ids: mutation.ids, summary });
        if (mutation.operation === "create") {
          return result({ task: compactTask(findCreatedChecklistTask(previous, tasks)), summary });
        }
        const affected = tasks.filter(
          (task) =>
            task.source === "vorteo" &&
            (task.id === mutation.id || mutation.addBlocks?.includes(task.id ?? "")),
        );
        return result({ tasks: affected.map(compactTask), summary });
      },
    },
  ];
}
