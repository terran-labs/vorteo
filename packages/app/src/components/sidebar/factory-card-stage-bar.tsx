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
import { factoryCardPassThrough } from "./factory-card-hover";

const MAX_TOOLTIP_ISSUES = 8;

/** A queue issue, tagged with its project when issues from several Factories share one bar. */
export type StageBarIssue = FactoryQueueIssue & { tag?: string };
const MAX_SUMMARY_ISSUES_PER_STAGE = 3;

/**
 * Queue counts by stage as a thin segmented bar. Expanded, each segment explains its issues and a
 * count row sits beneath; collapsed, the whole bar shares one summary. Every part opens the
 * overview, like the card around it.
 */
export function FactoryStageBar({
  issues,
  expanded,
  onOpenOverview,
}: {
  issues: readonly StageBarIssue[];
  expanded: boolean;
  onOpenOverview: () => void;
}) {
  const { t } = useTranslation();
  const counts = useMemo(() => factoryStageCounts(issues), [issues]);
  if (counts.length === 0) {
    return (
      <View pointerEvents="none" style={expanded ? styles.idleExpanded : styles.idleCollapsed}>
        <Text style={styles.idleText} numberOfLines={1}>
          {t("sidebar.factoryCard.idle")}
        </Text>
      </View>
    );
  }
  if (!expanded) {
    return (
      <Tooltip delayDuration={200}>
        <TooltipTrigger
          accessible={false}
          focusable={false}
          tabIndex={-1}
          aria-hidden
          onPress={onOpenOverview}
          style={[styles.collapsedBar, styles.passThrough]}
          testID="factory-card-stage-bar"
        >
          {counts.map((count) => (
            <View
              key={count.segment}
              style={[styles.bar, styles.segmentGrow(count.count), segmentColor[count.segment]]}
            />
          ))}
        </TooltipTrigger>
        <TooltipContent side="top" maxWidth={320}>
          <StageSummary counts={counts} />
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <View pointerEvents="box-none" style={styles.expanded}>
      <View pointerEvents="box-none" style={styles.segments} testID="factory-card-stage-bar">
        {counts.map((count) => (
          <Tooltip key={count.segment} delayDuration={200}>
            <TooltipTrigger
              accessible={false}
              focusable={false}
              tabIndex={-1}
              aria-hidden
              onPress={onOpenOverview}
              style={[styles.segmentHit, styles.segmentGrow(count.count), styles.passThrough]}
              testID={`factory-card-stage-${count.segment}`}
            >
              <View style={[styles.bar, segmentColor[count.segment]]} />
            </TooltipTrigger>
            <TooltipContent side="top" maxWidth={320}>
              <StageIssues count={count} limit={MAX_TOOLTIP_ISSUES} />
            </TooltipContent>
          </Tooltip>
        ))}
      </View>
      <View pointerEvents="none" style={styles.labels}>
        {counts.map((count) => (
          <Text key={count.segment} style={styles.label} numberOfLines={1}>
            {t(`sidebar.factoryCard.stageCounts.${count.segment}`, { count: count.count })}
          </Text>
        ))}
      </View>
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

function StageSummary({ counts }: { counts: readonly FactoryStageCount<StageBarIssue>[] }) {
  const { t } = useTranslation();
  const total = counts.reduce((sum, count) => sum + count.count, 0);
  return (
    <View style={styles.tooltipBody}>
      <Text style={styles.tooltipHeader}>
        {t("sidebar.factoryCard.queueHeader", { count: total })}
      </Text>
      {counts.map((count) => (
        <StageIssues key={count.segment} count={count} limit={MAX_SUMMARY_ISSUES_PER_STAGE} />
      ))}
    </View>
  );
}

const BAR_HEIGHT = 6;

const styles = StyleSheet.create((theme) => ({
  passThrough: { ...factoryCardPassThrough },
  expanded: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  segments: {
    flexDirection: "row",
    gap: 2,
  },
  // Taller than the bar so a pointer can find a segment.
  segmentHit: {
    paddingVertical: theme.spacing[1],
    minWidth: 6,
  },
  segmentGrow: (count: number) => ({ flexGrow: count, flexBasis: 0 }),
  bar: {
    height: BAR_HEIGHT,
    borderRadius: theme.borderRadius.sm,
  },
  collapsedBar: {
    flex: 1,
    minWidth: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    alignSelf: "stretch",
  },
  labels: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  idleExpanded: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  idleCollapsed: {
    flex: 1,
    alignItems: "flex-end",
  },
  idleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tooltipBody: { gap: theme.spacing[2] },
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
