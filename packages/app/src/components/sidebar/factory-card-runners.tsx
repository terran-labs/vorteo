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
import {
  LIST_ROW_HEIGHT,
  LIST_ROW_SPACING,
  LIST_ROW_TOUCH_HEIGHT,
} from "@/styles/list-row-metrics";
import { FactorySubheading } from "./factory-subheading";
import { sidebarIndentStyle } from "./indent";
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

/** A runner's issue; issues merged from several Factories carry their host and project tag. */
export type RunnerIssue = FactoryQueueIssue & { serverId?: string; tag?: string };

/** In-flight issues, each opening its most relevant agent. */
export function FactoryRunners({
  serverId,
  runners,
  level,
  onBeforeNavigate,
}: {
  /** The host of issues that do not name their own. */
  serverId?: string;
  runners: readonly RunnerIssue[];
  /** The Runners subheading's level; rows sit one further in. */
  level: number;
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  if (runners.length === 0) return null;
  return (
    <View pointerEvents="box-none" testID="factory-card-runners">
      <FactorySubheading
        label={t("sidebar.factoryCard.runners")}
        trailing={t("sidebar.factoryCard.runnersActive", { count: runners.length })}
        level={level}
      />
      {runners.map((issue) => (
        <RunnerRow
          key={`${issue.serverId ?? serverId}:${issue.tag ?? ""}#${issue.number}`}
          serverId={issue.serverId ?? serverId ?? ""}
          issue={issue}
          level={level + 1}
          onBeforeNavigate={onBeforeNavigate}
        />
      ))}
    </View>
  );
}

function RunnerRow({
  serverId,
  issue,
  level,
  onBeforeNavigate,
}: {
  serverId: string;
  issue: RunnerIssue;
  level: number;
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const boxStyle: Record<FactoryTrackBox, object> = {
    done: styles.done,
    current: styles.current,
    danger: styles.danger,
    pending: styles.pending,
  };
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
      style={[styles.row, sidebarIndentStyle(level), touch && styles.rowTouch, styles.rowHoverable]}
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
            {issue.tag ? (
              <Text style={styles.tag} numberOfLines={1}>
                {issue.tag}
              </Text>
            ) : null}
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

function RunnerTooltip({ issue }: { issue: RunnerIssue }) {
  const { t } = useTranslation();
  const lines: string[] = issue.tag ? [issue.tag] : [];
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    // The workspace rows' rhythm: same height, spacing, right edge and corner radius.
    minHeight: LIST_ROW_HEIGHT,
    marginBottom: LIST_ROW_SPACING,
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowTouch: { minHeight: LIST_ROW_TOUCH_HEIGHT },
  rowHoverable: hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover }),
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
  // A compact project tag that gives way to the title.
  tag: {
    flexShrink: 2,
    maxWidth: "40%",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  track: { flexDirection: "row", gap: 2, paddingVertical: theme.spacing[1] },
  box: { width: 6, height: 6, borderRadius: theme.borderRadius.sm },
  done: { backgroundColor: theme.colors.foregroundMuted },
  current: { backgroundColor: theme.colors.accent },
  danger: { backgroundColor: theme.colors.statusDanger },
  pending: { backgroundColor: theme.colors.border },
}));
