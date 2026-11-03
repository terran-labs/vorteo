import type {
  ProjectFactoryInstructions,
  ProjectFactoryRoleId,
} from "../../../../../plugins/factory/shared/project";

export type RoleId = ProjectFactoryRoleId;
export type Instructions = ProjectFactoryInstructions;
export const reviewNeedsAttention = (review: Instructions["review"]["status"]) => review !== "none";
export function instructionDiff(before: string, after: string) {
  if (before === after) return [];
  return [
    ...before.split("\n").map((text) => ({ kind: "removed" as const, text })),
    ...after.split("\n").map((text) => ({ kind: "added" as const, text })),
  ];
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
    },
  )) as Instructions;
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
        publish({ instructions, draft: instructions.additions, pending: false, error: null });
        input.onSaved();
      } catch (error) {
        publish({
          ...snapshot,
          pending: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
