import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleAlert } from "lucide-react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusRing } from "@/components/status-ring";
import { factoryAgentStatusKey } from "@/screens/factory/queue";
import { hoverStyle } from "@/styles/hover";
import { LIST_ROW_HEIGHT, LIST_ROW_TOUCH_HEIGHT } from "@/styles/list-row-metrics";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openExternalUrl } from "@/utils/open-external-url";
import { useVortonTouch } from "@/vorton-touch";
import {
  FACTORY_TRACK_STEPS,
  factoryRunnerAgent,
  factoryRunnerTrack,
  type FactoryQueueIssue,
  type FactoryTrackBox,
} from "./factory-card-model";

const ThemedCircleAlert = withUnistyles(CircleAlert);
const dangerColor = (theme: Theme) => ({ color: theme.colors.statusDanger });

/** In-flight issues, each opening its most relevant agent. */
export function FactoryRunners({
  serverId,
  runners,
  onBeforeNavigate,
}: {
  serverId: string;
  runners: readonly FactoryQueueIssue[];
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  if (runners.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={styles.section} testID="factory-card-runners">
      <View pointerEvents="none" style={styles.header}>
        <Text style={styles.headerText}>{t("sidebar.factoryCard.runners")}</Text>
        <Text style={styles.headerText}>
          {t("sidebar.factoryCard.runnersActive", { count: runners.length })}
        </Text>
      </View>
      {runners.map((issue) => (
        <RunnerRow
          key={issue.number}
          serverId={serverId}
          issue={issue}
          onBeforeNavigate={onBeforeNavigate}
        />
      ))}
    </View>
  );
}

function RunnerRow({
  serverId,
  issue,
  onBeforeNavigate,
}: {
  serverId: string;
  issue: FactoryQueueIssue;
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const touch = useVortonTouch() || isNative;
  const track = factoryRunnerTrack(issue);
  const open = useCallback(() => {
    const agent = factoryRunnerAgent(issue);
    onBeforeNavigate?.();
    if (agent) navigateToAgent({ serverId, agentId: agent.agentId });
    else void openExternalUrl(issue.url);
  }, [issue, onBeforeNavigate, serverId]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("sidebar.factoryCard.openRunner", {
        number: issue.number,
        title: issue.title,
      })}
      onPress={open}
      style={[styles.row, touch && styles.rowTouch, styles.rowHoverable]}
      highlightStyle={styles.rowPressed}
      testID={`factory-card-runner-${issue.number}`}
    >
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild passive>
          <View collapsable={false} style={styles.summary}>
            <View style={styles.activity}>
              {track.danger ? (
                <ThemedCircleAlert size={14} uniProps={dangerColor} />
              ) : (
                <View style={styles.ring}>
                  <StatusRing variant="task" tempo="calm" />
                </View>
              )}
            </View>
            <Text style={styles.number}>#{issue.number}</Text>
            <Text style={styles.title} numberOfLines={1}>
              {issue.title}
            </Text>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" maxWidth={320}>
          <RunnerTooltip issue={issue} />
        </TooltipContent>
      </Tooltip>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild passive>
          <View collapsable={false} style={styles.track} testID="factory-card-runner-track">
            {track.boxes.map((box, index) => (
              <View key={FACTORY_TRACK_STEPS[index]} style={[styles.box, boxStyle[box]]} />
            ))}
          </View>
        </TooltipTrigger>
        <TooltipContent side="top">
          <TrackTooltip issue={issue} />
        </TooltipContent>
      </Tooltip>
    </PressHighlight>
  );
}

function RunnerTooltip({ issue }: { issue: FactoryQueueIssue }) {
  const { t } = useTranslation();
  const lines: string[] = [];
  if (issue.pr) {
    lines.push(
      issue.pr.checks
        ? t("sidebar.factoryCard.pullRequestChecks", {
            number: issue.pr.number,
            checks: t(`projectFactory.checks.${issue.pr.checks}`),
          })
        : t("sidebar.factoryCard.pullRequest", { number: issue.pr.number }),
    );
  }
  for (const agent of issue.agents) {
    lines.push(
      t("sidebar.factoryCard.agentStatus", {
        role: t(`projectFactory.agents.${agent.role}`),
        status: t(factoryAgentStatusKey(agent.status)),
      }),
    );
  }
  if (issue.agents.length === 0) lines.push(t("sidebar.factoryCard.noAgents"));
  return (
    <TooltipText
      label={t("sidebar.factoryCard.issue", { number: issue.number, title: issue.title })}
      description={lines.join("\n")}
    />
  );
}

function TrackTooltip({ issue }: { issue: FactoryQueueIssue }) {
  const { t } = useTranslation();
  const track = factoryRunnerTrack(issue);
  const stage = t(`projectFactory.stages.${issue.stage}`);
  if (!track.step) return <TooltipText label={t("sidebar.factoryCard.trackQueued")} />;
  const step = t(`sidebar.factoryCard.steps.${track.step}`);
  return (
    <TooltipText
      label={t(
        track.danger ? "sidebar.factoryCard.trackDanger" : "sidebar.factoryCard.trackCurrent",
        { step, stage },
      )}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 2,
  },
  headerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: LIST_ROW_HEIGHT - 4,
    marginHorizontal: 2,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowTouch: { minHeight: LIST_ROW_TOUCH_HEIGHT },
  rowHoverable: hoverStyle({ backgroundColor: theme.colors.surface2 }),
  rowPressed: { backgroundColor: theme.colors.surface2 },
  summary: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  activity: { width: 16, alignItems: "center", justifyContent: "center" },
  ring: { transform: [{ scale: 0.8 }] },
  number: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  track: { flexDirection: "row", gap: 2, paddingVertical: theme.spacing[1] },
  box: { width: 6, height: 6, borderRadius: theme.borderRadius.sm },
  done: { backgroundColor: theme.colors.foregroundMuted },
  current: { backgroundColor: theme.colors.accent },
  danger: { backgroundColor: theme.colors.statusDanger },
  pending: { backgroundColor: theme.colors.border },
}));

const boxStyle: Record<FactoryTrackBox, object> = {
  done: styles.done,
  current: styles.current,
  danger: styles.danger,
  pending: styles.pending,
};
