import { create } from "zustand";

/**
 * Where "Open" outside a thread should land inside it: a question, or a pending approval, and the
 * timeline position recorded when it was asked. A null position means the daemon did not record
 * one, so the thread says it could not find the place instead of showing the latest message.
 */
export interface ConversationTarget {
  serverId: string;
  agentId: string;
  kind: "question" | "permission";
  id: string;
  seq: number | null;
  /** Distinguishes repeated opens of the same target, so each one jumps again. */
  requestId: number;
}

interface ConversationTargetState {
  target: ConversationTarget | null;
  set: (target: ConversationTarget) => void;
  clear: (requestId: number) => void;
}

// The target stays long enough to highlight its question after the thread mounts, then clears.
const TARGET_LIFETIME_MS = 20_000;
let nextRequestId = 0;

export const useConversationTargetStore = create<ConversationTargetState>((set) => ({
  target: null,
  set: (target) => set({ target }),
  clear: (requestId) =>
    set((state) => (state.target?.requestId === requestId ? { target: null } : state)),
}));

/** Opens a thread at a question or approval, through `navigate` (navigateToAgent in the app). */
export function openConversationTarget(
  target: Omit<ConversationTarget, "requestId">,
  navigate: (input: { serverId: string; agentId: string }) => unknown,
): ConversationTarget {
  const requestId = ++nextRequestId;
  const full = { ...target, requestId };
  useConversationTargetStore.getState().set(full);
  setTimeout(() => useConversationTargetStore.getState().clear(requestId), TARGET_LIFETIME_MS);
  navigate({ serverId: target.serverId, agentId: target.agentId });
  return full;
}

/** The pending target for one thread, or null. */
export function useConversationTarget(serverId: string, agentId: string) {
  return useConversationTargetStore((state) =>
    state.target?.serverId === serverId && state.target.agentId === agentId ? state.target : null,
  );
}
