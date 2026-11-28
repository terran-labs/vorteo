import { useEffect, useState } from "react";
import { queuedNoticeRemainingMs } from "@/composer/submit";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * After the composer queues a message behind a running turn (#720): the Queue card unfolds so the
 * owner sees the message there, and the composer says briefly that it is queued. Without this a
 * queued send only cleared the input, and owners pressed Send again.
 */

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const key = (serverId: string, agentId: string) => `${serverId}\u0000${agentId}`;

/** Asks the thread's Queue card to unfold. */
export function requestQueueReview(serverId: string, agentId: string): void {
  for (const listener of listeners.get(key(serverId, agentId)) ?? []) listener();
}

/** Calls `onRequest` whenever the composer asks this thread's Queue card to unfold. */
export function useQueueReviewRequests(
  serverId: string | undefined,
  agentId: string,
  onRequest: Listener,
) {
  useEffect(() => {
    if (!serverId) return;
    const id = key(serverId, agentId);
    const set = listeners.get(id) ?? new Set<Listener>();
    set.add(onRequest);
    listeners.set(id, set);
    return () => {
      set.delete(onRequest);
      if (set.size === 0) listeners.delete(id);
    };
  }, [agentId, onRequest, serverId]);
}

/**
 * The queued confirmation: committed to this device's outbox, sent when the running turn
 * finishes. Shown only while younger than its display time, so a remount after a later error
 * cannot bring it back; a later rejection shows on the item in the Queue card.
 */
export function ComposerQueuedNotice({ queuedAt }: { queuedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  const remaining = queuedNoticeRemainingMs(queuedAt, now);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [remaining]);
  if (remaining <= 0) return null;
  return (
    <Text accessibilityRole="text" style={styles.queued} testID="composer-queued-notice">
      {"✓ Queued. It sends when this turn finishes; see Queue above to edit it or send it now."}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  queued: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
