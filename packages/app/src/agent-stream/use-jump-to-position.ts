import { useEffect, useRef, useState, type RefObject } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "./strategy";

const NO_ITEMS: StreamItem[] = [];
const MISSING_GRACE_MS = 2_000;

interface PendingJump {
  requestId: number;
  seq: number;
  fetchSettled: boolean;
  hasScrolled: boolean;
}

/**
 * The loaded item at the target position, or the nearest one before it. Null when the loaded
 * window starts after the target, which means older history must be fetched first.
 */
export function findItemAtOrBefore(
  items: readonly StreamItem[],
  epoch: string | null,
  seq: number,
): StreamItem | null {
  let best: StreamItem | null = null;
  let bestSeq = -1;
  for (const item of items) {
    const cursor = item.timelineCursor;
    if (!cursor || cursor.epoch !== epoch || cursor.seq > seq) continue;
    if (cursor.seq > bestSeq) {
      best = item;
      bestSeq = cursor.seq;
    }
  }
  return best;
}

/**
 * Scrolls the conversation to a recorded timeline position, loading older history when needed.
 * Calls `onMissing` when the position cannot be found, rather than leaving the latest message.
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
  onMissing: () => void;
  onError: () => void;
}): (seq: number) => void {
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
  const [pending, setPending] = useState<PendingJump | null>(null);
  const nextRequestIdRef = useRef(0);
  const onMissing = useStableEvent(input.onMissing);
  const onError = useStableEvent(input.onError);

  useEffect(() => setPending(null), [agentId, serverId, timelineEpoch]);

  useEffect(() => {
    if (pending === null || pending.hasScrolled) return;
    const target =
      findItemAtOrBefore(tail, timelineEpoch, pending.seq) ??
      findItemAtOrBefore(head, timelineEpoch, pending.seq);
    if (target) {
      const isMounted =
        mountedHistoryMessageIds === undefined ||
        mountedHistoryMessageIds.has(target.id) ||
        head.includes(target);
      if (!isMounted) {
        revealLoadedMessage?.(target.id);
        return;
      }
      viewportRef.current?.scrollToMessage?.(target.id);
      setPending((current) =>
        current?.requestId === pending.requestId ? { ...current, hasScrolled: true } : current,
      );
      return;
    }
    if (!pending.fetchSettled) return;
    // A fetched window can settle a moment before its items render; items arriving re-run this
    // effect and cancel the report.
    const timer = setTimeout(() => {
      setPending((current) => (current?.requestId === pending.requestId ? null : current));
      onMissing();
    }, MISSING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [
    head,
    mountedHistoryMessageIds,
    onMissing,
    pending,
    revealLoadedMessage,
    tail,
    timelineEpoch,
    viewportRef,
  ]);

  return useStableEvent((seq: number) => {
    const requestId = ++nextRequestIdRef.current;
    if (timelineEpoch === null) {
      onMissing();
      return;
    }
    const loaded =
      findItemAtOrBefore(tail, timelineEpoch, seq) ?? findItemAtOrBefore(head, timelineEpoch, seq);
    if (loaded) {
      setPending({ requestId, seq, fetchSettled: true, hasScrolled: false });
      return;
    }
    setPending({ requestId, seq, fetchSettled: false, hasScrolled: false });
    void getHostRuntimeStore()
      .fetchAgentTimeline(serverId, agentId, planTimelinePromptJump({ epoch: timelineEpoch, seq }))
      .catch((error: unknown) => {
        console.warn("Failed to load the conversation around a question", error);
        onError();
      })
      .finally(() => {
        setPending((current) =>
          current?.requestId === requestId ? { ...current, fetchSettled: true } : current,
        );
      });
  });
}
