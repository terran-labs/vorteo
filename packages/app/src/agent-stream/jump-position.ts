import type { StreamItem } from "@/types/stream";

// Pure position rules for jumping to a recorded timeline position (#660), kept apart from the
// hook so they load without the host runtime.

/**
 * The loaded item that ends at the target position or closest before it, within one contiguous
 * list of items. Item cursors mark where each item ends. Null unless the list also reaches past
 * the target, or is the live tail (`reachesNow`): a list that ends before the target may leave
 * the real neighbourhood in an unloaded gap, so older history must be fetched first.
 */
export function findItemAtOrBefore(
  items: readonly StreamItem[],
  epoch: string | null,
  seq: number,
  reachesNow = false,
): StreamItem | null {
  let best: StreamItem | null = null;
  let bestSeq = -1;
  let lastSeq = -1;
  for (const item of items) {
    const cursor = item.timelineCursor;
    if (!cursor || cursor.epoch !== epoch) continue;
    lastSeq = Math.max(lastSeq, cursor.seq);
    if (cursor.seq <= seq && cursor.seq > bestSeq) {
      best = item;
      bestSeq = cursor.seq;
    }
  }
  if (!best) return null;
  return reachesNow || lastSeq >= seq ? best : null;
}

/** The candidate in the live tail, then in loaded older history. */
export function findLoaded(
  tail: readonly StreamItem[],
  head: readonly StreamItem[],
  epoch: string | null,
  seq: number,
): StreamItem | null {
  return findItemAtOrBefore(tail, epoch, seq, true) ?? findItemAtOrBefore(head, epoch, seq);
}

/**
 * Whether a fetched window can hold the target: same epoch, and it starts at or before the
 * target. Otherwise the position is gone (a new epoch, or history that starts after it).
 */
export function fetchedWindowCovers(
  page: { epoch: string; entries: ReadonlyArray<{ seqStart: number }> },
  target: { epoch: string; seq: number },
): boolean {
  if (page.epoch !== target.epoch || page.entries.length === 0) return false;
  return Math.min(...page.entries.map((entry) => entry.seqStart)) <= target.seq;
}
