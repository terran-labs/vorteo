import { useEffect, useState } from "react";
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

/** How long the queued confirmation stays under the composer. */
export const QUEUED_NOTICE_MS = 6_000;

/** The queued confirmation: accepted, and sent when the running turn finishes. */
export function ComposerQueuedNotice({ queuedAt }: { queuedAt: number | null }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (queuedAt === null) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), QUEUED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [queuedAt]);
  if (!visible) return null;
  return (
    <Text accessibilityRole="text" style={styles.queued} testID="composer-queued-notice">
      {"✓ Queued; it will be sent when this turn finishes. Edit it or send it now in Queue above."}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  queued: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
