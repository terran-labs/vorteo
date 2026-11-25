import { create } from "zustand";

/**
 * Where "Open" outside a thread should land inside it: a question, or a pending approval, and the
 * timeline position recorded when it was asked. The position is a sequence number within one
 * timeline epoch; a null position or epoch means the daemon did not record one, so the thread
 * says it could not find the place instead of showing the latest message.
 */
export interface ConversationTarget {
  serverId: string;
  agentId: string;
  kind: "question" | "permission";
  id: string;
  seq: number | null;
  epoch: string | null;
  /** Distinguishes repeated opens of the same target, so each one jumps again. */
  requestId: number;
  /** When the thread must stop trying and say it could not find the place (ms since epoch). */
  expiresAt: number;
}

/** The question or approval to highlight, which outlives the one-shot jump. */
export type ConversationHighlight = Pick<
  ConversationTarget,
  "serverId" | "agentId" | "kind" | "id"
>;

interface ConversationTargetState {
  target: ConversationTarget | null;
  highlight: (ConversationHighlight & { requestId: number }) | null;
  set: (target: ConversationTarget) => void;
  /** Consumes the jump: called once it scrolled, was reported missing, or was cancelled. */
  clear: (requestId: number) => void;
  clearHighlight: (requestId: number) => void;
}

// How long the thread may take to mount and load before it reports the place missing.
export const TARGET_LIFETIME_MS = 20_000;
// The highlight stays a little longer, so a slow jump still lands on a marked question.
const HIGHLIGHT_LIFETIME_MS = 30_000;
let nextRequestId = 0;

export const useConversationTargetStore = create<ConversationTargetState>((set) => ({
  target: null,
  highlight: null,
  set: (target) =>
    set({
      target,
      highlight: {
        serverId: target.serverId,
        agentId: target.agentId,
        kind: target.kind,
        id: target.id,
        requestId: target.requestId,
      },
    }),
  clear: (requestId) =>
    set((state) => (state.target?.requestId === requestId ? { target: null } : state)),
  clearHighlight: (requestId) =>
    set((state) => (state.highlight?.requestId === requestId ? { highlight: null } : state)),
}));

/** Opens a thread at a question or approval, through `navigate` (navigateToAgent in the app). */
export function openConversationTarget(
  target: Omit<ConversationTarget, "requestId" | "expiresAt">,
  navigate: (input: { serverId: string; agentId: string }) => unknown,
): ConversationTarget {
  const requestId = ++nextRequestId;
  const full = { ...target, requestId, expiresAt: Date.now() + TARGET_LIFETIME_MS };
  const store = useConversationTargetStore.getState();
  store.set(full);
  // The thread reports an expired target itself; this only covers a thread that never mounted.
  setTimeout(
    () => useConversationTargetStore.getState().clear(requestId),
    TARGET_LIFETIME_MS + 1_000,
  );
  setTimeout(
    () => useConversationTargetStore.getState().clearHighlight(requestId),
    HIGHLIGHT_LIFETIME_MS,
  );
  navigate({ serverId: target.serverId, agentId: target.agentId });
  return full;
}

/** The pending jump for one thread, or null. */
export function useConversationTarget(serverId: string, agentId: string) {
  return useConversationTargetStore((state) =>
    state.target?.serverId === serverId && state.target.agentId === agentId ? state.target : null,
  );
}

/** The question or approval to highlight in one thread, or null. */
export function useConversationHighlight(serverId: string, agentId: string) {
  return useConversationTargetStore((state) =>
    state.highlight?.serverId === serverId && state.highlight.agentId === agentId
      ? state.highlight
      : null,
  );
}
