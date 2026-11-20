import { memo, useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useSessionStore } from "@/stores/session-store";
import { hoverStyle } from "@/styles/hover";
import { formatMessageTimestamp } from "@/utils/time";
import type { MachineGroup } from "./model";

const Down = withUnistyles(ChevronDown, (theme) => ({ color: theme.colors.foregroundMuted }));
const Right = withUnistyles(ChevronRight, (theme) => ({ color: theme.colors.foregroundMuted }));
const CHEVRON_SIZE = 14;

/**
 * The muted line a run of machine rows collapses into: who sent the first one, what it is,
 * when it arrived and how it begins, with a count when the run holds several. Pressing it
 * shows the rows themselves beneath.
 *
 * This is not the shared `ExpandableBadge`: that badge takes no accessibility label, has no
 * 44px target and has no slot for a count, and it lives in a file this slice does not touch.
 */
export const MachineTurnLine = memo(function MachineTurnLine({
  group,
  serverId,
  onExpandedChange,
}: {
  group: MachineGroup;
  serverId?: string;
  onExpandedChange: (group: MachineGroup, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(
    () => onExpandedChange(group, !group.expanded),
    [group, onExpandedChange],
  );
  const accessibilityState = useMemo(() => ({ expanded: group.expanded }), [group.expanded]);
  const first = group.rows[0];
  const sender = first?.sender;
  // The sender's current title, as the attributed message bubble resolves it.
  const liveTitle = useSessionStore((state) => {
    const host = sender?.serverId ?? serverId;
    const session = host ? state.sessions[host] : undefined;
    if (!sender || !session) return undefined;
    return (session.agents.get(sender.id) ?? session.agentDetails.get(sender.id))?.title;
  });
  if (!first) return null;
  const senderName = sender ? (liveTitle ?? sender.title ?? sender.id) : undefined;
  const sentBy = senderName ? t("turnSummary.sentBy", { name: senderName }) : undefined;
  const time = formatMessageTimestamp(first.timestamp);
  // A received message is named by who sent it, as its own bubble is.
  const heading = (first.label ? [senderName, first.label, time] : [sentBy, time])
    .filter(Boolean)
    .join(" · ");
  const count = group.rows.length > 1 ? String(group.rows.length) : undefined;
  const accessibilityLabel = [count, first.label, sentBy, time, first.preview]
    .filter(Boolean)
    .join(", ");
  const Chevron = group.expanded ? Down : Right;

  return (
    <PressHighlight
      testID="machine-turn-line"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      onPress={toggle}
      style={styles.line}
      highlightStyle={styles.linePressed}
    >
      <Chevron size={CHEVRON_SIZE} />
      {count ? (
        <View style={styles.count}>
          <Text style={styles.countText}>{count}</Text>
        </View>
      ) : null}
      <Text style={styles.heading} numberOfLines={1}>
        {heading}
      </Text>
      {first.preview ? (
        <Text style={styles.preview} numberOfLines={1}>
          {first.preview}
        </Text>
      ) : null}
    </PressHighlight>
  );
});

const styles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "stretch",
    minHeight: 44,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    ...hoverStyle({ backgroundColor: theme.colors.surface1 }),
  },
  linePressed: { backgroundColor: theme.colors.surface2 },
  count: {
    flexShrink: 0,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  countText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  heading: {
    flexShrink: 0,
    maxWidth: "60%",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  preview: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    opacity: 0.7,
  },
}));
