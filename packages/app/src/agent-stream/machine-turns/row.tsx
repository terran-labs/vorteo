import { memo, useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
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
 */
export const MachineTurnLine = memo(function MachineTurnLine({
  group,
  onExpandedChange,
}: {
  group: MachineGroup;
  onExpandedChange: (hostId: string, expanded: boolean) => void;
}) {
  const toggle = useCallback(
    () => onExpandedChange(group.hostId, !group.expanded),
    [group.expanded, group.hostId, onExpandedChange],
  );
  const accessibilityState = useMemo(() => ({ expanded: group.expanded }), [group.expanded]);
  const first = group.rows[0];
  if (!first) return null;
  const heading = [first.sender, first.kind, formatMessageTimestamp(first.timestamp)]
    .filter(Boolean)
    .join(" · ");
  const Chevron = group.expanded ? Down : Right;

  return (
    <PressHighlight
      testID="machine-turn-line"
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={toggle}
      style={styles.line}
      highlightStyle={styles.linePressed}
    >
      <Chevron size={CHEVRON_SIZE} />
      {group.rows.length > 1 ? (
        <View style={styles.count}>
          <Text style={styles.countText}>{group.rows.length}</Text>
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
