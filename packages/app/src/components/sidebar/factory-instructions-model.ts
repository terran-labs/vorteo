import { buildLineDiff } from "@/utils/tool-call-parsers";
import type {
  ProjectFactoryInstructions,
  ProjectFactoryRoleId,
} from "../../../../../plugins/factory/shared/project";

export type RoleId = ProjectFactoryRoleId;
export type Instructions = ProjectFactoryInstructions;
export const reviewNeedsAttention = (review: Instructions["review"]["status"]) => review !== "none";
export function instructionDiff(before: string, after: string) {
  if (before === after) return [];
  const lines = buildLineDiff(before, after).map((line) => ({
    kind: ({ add: "added", remove: "removed", context: "context", header: "context" } as const)[
      line.type
    ],
    text: line.content.slice(1),
  }));
  const visible = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].kind === "context") continue;
    for (
      let context = Math.max(0, index - 3);
      context <= Math.min(lines.length - 1, index + 3);
      context++
    )
      visible.add(context);
  }
  if (visible.size === 0) return [];
  const result: {
    kind: "added" | "removed" | "context" | "collapsed";
    text: string;
    count?: number;
  }[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (visible.has(index)) result.push(lines[index]);
    else {
      const previous = result.at(-1);
      if (previous?.kind === "collapsed") previous.count = (previous.count ?? 0) + 1;
      else result.push({ kind: "collapsed", text: "", count: 1 });
    }
  }
  return result;
}
/** Keep the opened revision until a successful write; a conflict never discards the draft. */
export async function writeInstructions(
  invoke: (method: string, input: unknown) => Promise<unknown>,
  projectId: string,
  state: Instructions,
  change: { additions: string } | { accept: boolean },
) {
  return (await invoke(
    `factory.project.instructions.${"additions" in change ? "set" : "resolve"}`,
    {
      projectId,
      role: state.role,
      expectedRevision: state.revision,
      ...change,
      ...("accept" in change && change.accept
        ? { proposedAt: requireProposal(state).proposedAt }
        : {}),
    },
  )) as Instructions;
}

function requireProposal(state: Instructions) {
  const proposal = state.review.status === "proposed" ? state.review.proposal : null;
  if (!proposal) throw new Error("The proposal changed or is no longer available.");
  return proposal;
}
/**
 * Copies of PROJECT_FACTORY_INSTRUCTION_CONFLICTS in plugins/factory/shared/project.ts, the
 * openings of the daemon's revision and proposal conflict errors. Plugin RPC errors carry only a
 * message. A copy keeps plugin source out of the app bundle; a test checks it against the source.
 */
export const INSTRUCTION_CONFLICT_MESSAGES = [
  "These instructions changed since you loaded them",
  "The Mechanic replaced this proposal since you loaded it",
  "There is no proposal to accept for this role",
] as const;
export function isInstructionsConflict(error: unknown) {
  return (
    error instanceof Error &&
    INSTRUCTION_CONFLICT_MESSAGES.some((message) => error.message.includes(message))
  );
}

/** One opening captures its revision. Background reads never replace an unsaved draft. */
export function openFactoryInstructionsForm(input: {
  initial: Instructions;
  projectId: string;
  invoke: (method: string, input: unknown) => Promise<unknown>;
  onSaved: () => void;
}) {
  let snapshot = {
    instructions: input.initial,
    draft: input.initial.additions,
    pending: false,
    error: null as string | null,
    conflict: false,
  };
  const listeners = new Set<() => void>();
  const publish = (next: typeof snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getState: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setDraft(draft: string) {
      if (!snapshot.pending) publish({ ...snapshot, draft, error: null });
    },
    async write(change: { additions: string } | { accept: boolean }) {
      if (snapshot.pending) return;
      publish({ ...snapshot, pending: true, error: null });
      try {
        const instructions = await writeInstructions(
          input.invoke,
          input.projectId,
          snapshot.instructions,
          change,
        );
        publish({
          instructions,
          draft: instructions.additions,
          pending: false,
          error: null,
          conflict: false,
        });
        input.onSaved();
      } catch (error) {
        if (isInstructionsConflict(error)) {
          try {
            const instructions = (await input.invoke("factory.project.instructions.get", {
              projectId: input.projectId,
              role: snapshot.instructions.role,
            })) as Instructions;
            publish({ ...snapshot, instructions, pending: false, error: null, conflict: true });
            return;
          } catch {
            // Keep the original failure and draft if the latest snapshot cannot be loaded.
          }
        }
        publish({
          ...snapshot,
          pending: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
