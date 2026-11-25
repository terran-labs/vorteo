import { useEffect, useRef, useState, type RefObject } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "./strategy";
import { fetchedWindowCovers, findLoaded } from "./jump-position";

const NO_ITEMS: StreamItem[] = [];

/** A recorded timeline position. A null epoch means none was recorded, so it cannot be found. */
export interface JumpTarget {
  epoch: string | null;
  seq: number;
}

export type JumpOutcome = "scrolled" | "missing" | "cancelled";

interface PendingJump {
  requestId: number;
  seq: number;
}

// What a reader does to take over the scroll; any of them cancels a jump still loading.
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Scrolls the conversation to a recorded timeline position, loading older history when needed.
 * Reports one outcome per jump: scrolled, missing (the position is not in this timeline), or
 * cancelled (the reader scrolled first). A fetched window that covers the position waits for its
 * items to render, however long that takes; only the fetch result decides that it is missing.
 */
export function useJumpToPosition(input: {
  agentId: string;
  serverId: string;
  timelineEpoch: string | null;
  tail: StreamItem[];
  head: StreamItem[] | undefined;
  viewportRef: RefObject<StreamViewportHandle | null>;
  mountedHistoryMessageIds?: ReadonlySet<string>;
  revealLoadedMessage?: (messageId: string) => boolean;
  onOutcome: (outcome: JumpOutcome) => void;
  onError: () => void;
}): { jump: (target: JumpTarget) => void; cancel: () => void } {
  const {
    agentId,
    serverId,
    timelineEpoch,
    tail,
    viewportRef,
    mountedHistoryMessageIds,
    revealLoadedMessage,
  } = input;
  const head = input.head ?? NO_ITEMS;
  const [pending, setPendingState] = useState<PendingJump | null>(null);
  // Mirrors `pending` synchronously, so each jump reports exactly one outcome.
  const pendingRef = useRef<PendingJump | null>(null);
  const nextRequestIdRef = useRef(0);
  const onOutcome = useStableEvent(input.onOutcome);
  const onError = useStableEvent(input.onError);

  const setPending = useStableEvent((next: PendingJump | null) => {
    pendingRef.current = next;
    setPendingState(next);
  });
  const settle = useStableEvent((requestId: number, outcome: JumpOutcome) => {
    if (pendingRef.current?.requestId !== requestId) return;
    setPending(null);
    onOutcome(outcome);
  });

  useEffect(() => setPending(null), [agentId, serverId, timelineEpoch, setPending]);

  // The reader takes over: a jump still loading must not pull them back afterwards.
  useEffect(() => {
    if (pending === null || typeof window === "undefined" || !window.addEventListener) return;
    const cancel = () => settle(pending.requestId, "cancelled");
    for (const name of USER_SCROLL_EVENTS) {
      window.addEventListener(name, cancel, { capture: true, passive: true });
    }
    return () => {
      for (const name of USER_SCROLL_EVENTS) {
        window.removeEventListener(name, cancel, { capture: true });
      }
    };
  }, [pending, settle]);

  useEffect(() => {
    if (pending === null) return;
    const target = findLoaded(tail, head, timelineEpoch, pending.seq);
    if (!target) return;
    const isMounted =
      mountedHistoryMessageIds === undefined ||
      mountedHistoryMessageIds.has(target.id) ||
      head.includes(target);
    if (!isMounted) {
      revealLoadedMessage?.(target.id);
      return;
    }
    viewportRef.current?.scrollToMessage?.(target.id);
    settle(pending.requestId, "scrolled");
  }, [
    head,
    mountedHistoryMessageIds,
    pending,
    revealLoadedMessage,
    settle,
    tail,
    timelineEpoch,
    viewportRef,
  ]);

  // Drops a pending jump without an outcome, once its target has gone.
  const cancel = useStableEvent(() => setPending(null));
  const jump = useStableEvent((target: JumpTarget) => {
    const requestId = ++nextRequestIdRef.current;
    const epoch = target.epoch;
    // A position from another epoch names an unrelated item in this one; never match it.
    if (timelineEpoch === null || epoch === null || epoch !== timelineEpoch) {
      setPending(null);
      onOutcome("missing");
      return;
    }
    const seq = target.seq;
    setPending({ requestId, seq });
    if (findLoaded(tail, head, epoch, seq)) return;
    void getHostRuntimeStore()
      .fetchAgentTimeline(serverId, agentId, planTimelinePromptJump({ epoch, seq }))
      .then((page) => {
        // A covering window keeps the jump pending until its items render.
        if (!fetchedWindowCovers(page, { epoch, seq })) settle(requestId, "missing");
        return undefined;
      })
      .catch((error: unknown) => {
        console.warn("Failed to load the conversation around a question", error);
        settle(requestId, "cancelled");
        onError();
      });
  });
  return { jump, cancel };
}
