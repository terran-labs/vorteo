import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  factoryStageCounts,
  type FactoryQueueIssue,
  type FactoryStageCount,
  type FactoryStageSegment,
} from "./factory-card-model";

const MAX_TOOLTIP_ISSUES = 8;

/** A queue issue, tagged with its project when issues from several Factories share one bar. */
export type StageBarIssue = FactoryQueueIssue & { tag?: string };

/**
 * Queue counts by stage as a thin segmented bar on a Factory section row. Each segment explains its
 * issues on hover; pressing it acts like pressing the row.
 */
export function FactoryStageBar({
  issues,
  onPress,
}: {
  issues: readonly StageBarIssue[];
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const counts = useMemo(() => factoryStageCounts(issues), [issues]);
  if (counts.length === 0) {
    return (
      <View pointerEvents="none" style={styles.bar}>
        <Text style={styles.idleText} numberOfLines={1}>
          {t("sidebar.factoryCard.idle")}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.bar} testID="factory-card-stage-bar">
      {counts.map((count) => (
        <Tooltip key={count.segment} delayDuration={200}>
          <TooltipTrigger
            accessible={false}
            focusable={false}
            tabIndex={-1}
            aria-hidden
            onPress={onPress}
            style={[styles.segmentHit, styles.segmentGrow(count.count)]}
            testID={`factory-card-stage-${count.segment}`}
          >
            <View style={[styles.segment, segmentColor[count.segment]]} />
          </TooltipTrigger>
          <TooltipContent side="top" maxWidth={320}>
            <StageIssues count={count} limit={MAX_TOOLTIP_ISSUES} />
          </TooltipContent>
        </Tooltip>
      ))}
    </View>
  );
}

function StageIssues({ count, limit }: { count: FactoryStageCount<StageBarIssue>; limit: number }) {
  const { t } = useTranslation();
  const shown = count.issues.slice(0, limit);
  const more = count.issues.length - shown.length;
  return (
    <View style={styles.tooltipGroup}>
      <Text style={styles.tooltipHeader}>
        {t("sidebar.factoryCard.stageHeader", {
          stage: t(`sidebar.factoryCard.stageNames.${count.segment}`),
          count: count.count,
        })}
      </Text>
      {shown.map((issue) => (
        <Text
          key={`${issue.tag ?? ""}#${issue.number}`}
          style={styles.tooltipIssue}
          numberOfLines={1}
        >
          {t("sidebar.factoryCard.issue", { number: issue.number, title: issue.title })}
          {issue.tag ? <Text style={styles.tooltipTag}>{` · ${issue.tag}`}</Text> : null}
        </Text>
      ))}
      {more > 0 ? (
        <Text style={styles.tooltipMore}>
          {t("sidebar.factoryCard.moreIssues", { count: more })}
        </Text>
      ) : null}
    </View>
  );
}

const BAR_HEIGHT = 6;

/** Wide enough to read proportions, narrow enough to leave the title room. */
const BAR_WIDTH = 56;

const styles = StyleSheet.create((theme) => ({
  bar: {
    width: BAR_WIDTH,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 2,
    alignSelf: "stretch",
  },
  // Taller than the bar so a pointer can find a segment.
  segmentHit: {
    alignSelf: "stretch",
    justifyContent: "center",
    minWidth: 6,
  },
  segmentGrow: (count: number) => ({ flexGrow: count, flexBasis: 0 }),
  segment: {
    height: BAR_HEIGHT,
    borderRadius: theme.borderRadius.sm,
  },
  idleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipGroup: { gap: 2 },
  tooltipHeader: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  tooltipIssue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipTag: { color: theme.colors.foregroundExtraMuted },
  tooltipMore: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  queued: { backgroundColor: theme.colors.foregroundExtraMuted },
  planning: { backgroundColor: theme.colors.foregroundMuted },
  building: { backgroundColor: theme.colors.accent },
  review: { backgroundColor: theme.colors.statusMerged },
  repair: { backgroundColor: theme.colors.statusDanger },
  merging: { backgroundColor: theme.colors.statusSuccess },
}));

const segmentColor: Record<FactoryStageSegment, object> = {
  queued: styles.queued,
  planning: styles.planning,
  building: styles.building,
  review: styles.review,
  repair: styles.repair,
  merging: styles.merging,
};
