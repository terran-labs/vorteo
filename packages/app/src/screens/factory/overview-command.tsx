import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import {
  ChevronLeft,
  CircleAlert,
  CircleX,
  FilePen,
  GitPullRequest,
  Hand,
  Lock,
  MessageCircleQuestionMark,
  OctagonPause,
  Play,
  ZoomIn,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { openFactoryInstructions } from "@/components/sidebar/factory-instructions";
import { factoryStatePill } from "@/components/sidebar/factory-card-model";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { hoverStyle } from "@/styles/hover";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  aggregateStageCounts,
  needsYouByFactory,
  type FactoryScopeEntry,
  type NeedsYouItem,
  type NeedsYouKind,
} from "./all-factories-model";
import { FactoryControlStrip } from "./overview-controls";
import type { FactoryOverviewData } from "./overview-data";
import { SampleTag, StageRing } from "./overview-kit";
import { FACTORY_LANES } from "./overview-model";
import { allFactoriesOverviewRoute } from "./routes";

// ---------------------------------------------------------------------------------------------
// Icons, colored through the theme

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIcon = (theme: Theme) => ({ color: theme.colors.statusWarning });
const dangerIcon = (theme: Theme) => ({ color: theme.colors.statusDanger });
const accentIcon = (theme: Theme) => ({ color: theme.colors.statusDotRunning });

const KIND_ICONS: Record<NeedsYouKind, LucideIcon> = {
  question: MessageCircleQuestionMark,
  proposal: FilePen,
  instructionsReview: FilePen,
  drain: OctagonPause,
  humanReview: Hand,
  failingChecks: CircleX,
  claim: Lock,
  awaitingApproval: GitPullRequest,
  blocked: CircleAlert,
};
const ThemedMessage = withUnistyles(MessageCircleQuestionMark);
type ThemedIconComponent = typeof ThemedMessage;
const THEMED_ICONS = Object.fromEntries(
  Object.entries(KIND_ICONS).map(([kind, Icon]) => [kind, withUnistyles(Icon)]),
) as Record<NeedsYouKind, ThemedIconComponent>;

function kindIconColor(kind: NeedsYouKind) {
  switch (kind) {
    case "question":
    case "proposal":
      return accentIcon;
    case "failingChecks":
    case "blocked":
      return dangerIcon;
    case "drain":
    case "humanReview":
    case "claim":
      return warningIcon;
    default:
      return mutedIcon;
  }
}

// ---------------------------------------------------------------------------------------------
// Scope

/** "All Factories" from a project's overview: zooms out to every Factory in the installation. */
export function ScopeBack({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const back = useCallback(() => router.navigate(allFactoriesOverviewRoute(serverId)), [serverId]);
  return (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={ChevronLeft}
      onPress={back}
      testID="factory-scope-all"
    >
      {t("projectFactory.scope.all")}
    </Button>
  );
}

// ---------------------------------------------------------------------------------------------
// Stop switch and drain banner

/** Stop or resume every Factory on the shown hosts; distinct from one project's Pause. */
export function StopSwitch({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const { stopAll, drains } = data;
  const resumeAll = useCallback(() => stopAll.resume(), [stopAll]);
  if (!stopAll.available) return null;
  return drains.length ? (
    <Button
      variant="outline"
      leftIcon={Play}
      onPress={resumeAll}
      disabled={stopAll.pending || data.sample}
      testID="factory-resume-all"
    >
      {t("projectFactory.stopAll.resume")}
    </Button>
  ) : (
    <Button
      variant="outline"
      leftIcon={OctagonPause}
      onPress={stopAll.stop}
      disabled={stopAll.pending || data.sample}
      testID="factory-stop-all"
    >
      {t("projectFactory.stopAll.stop")}
    </Button>
  );
}

/** Calm, persistent notice while pause_all holds Factories, with the way back. */
export function DrainBanners({ data }: { data: FactoryOverviewData }) {
  if (!data.drains.length && !data.stopAll.error) return null;
  return (
    <View style={styles.banners}>
      {data.drains.map((entry) => (
        <DrainBanner
          key={`${entry.serverId}:${entry.drain.id}`}
          serverId={entry.serverId}
          reason={entry.drain.reason}
          pausedAt={entry.drain.pausedAt}
          projects={entry.projects}
          data={data}
        />
      ))}
      {data.stopAll.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {data.stopAll.error}
        </Text>
      ) : null}
    </View>
  );
}

function DrainBanner({
  serverId,
  reason,
  pausedAt,
  projects,
  data,
}: {
  serverId: string;
  reason: string;
  pausedAt: string;
  projects: number;
  data: FactoryOverviewData;
}) {
  const { t } = useTranslation();
  const date = useMemo(() => new Date(pausedAt), [pausedAt]);
  const age = useTimeAgo(date);
  const host = data.factories.find((entry) => entry.serverId === serverId)?.hostLabel;
  const resume = useCallback(() => data.stopAll.resume(serverId), [data.stopAll, serverId]);
  return (
    <View style={styles.banner} testID="factory-drain-banner" accessibilityRole="alert">
      <ThemedIcon icon="drain" />
      <View style={styles.bannerText}>
        <Text style={styles.bannerTitle}>
          {t("projectFactory.stopAll.bannerTitle", { count: projects })}
          {host ? <Text style={styles.muted}>{` · ${host}`}</Text> : null}
        </Text>
        <Text style={styles.muted} numberOfLines={2}>
          {t("projectFactory.stopAll.bannerDetail", { reason, age })}
        </Text>
      </View>
      <Button onPress={resume} disabled={data.stopAll.pending || data.sample}>
        {t("projectFactory.stopAll.resume")}
      </Button>
    </View>
  );
}

function ThemedIcon({ icon }: { icon: NeedsYouKind }) {
  const Icon = THEMED_ICONS[icon];
  return <Icon size={16} uniProps={kindIconColor(icon)} />;
}

/**
 * The control line for the scope: one Factory's strip with the stop switch set apart at its
 * end, or for every Factory a summary and the stop switch.
 */
export function ScopeControls({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const stop = useMemo(() => <StopSwitch data={data} />, [data]);
  if (data.focus) {
    return (
      <FactoryControlStrip
        serverId={data.serverId}
        projectId={data.focus.projectId}
        state={data.focus.state}
        controls={data.focus.controls}
        extra={stop}
      />
    );
  }
  const running = data.factories.filter((entry) => entry.status === "on").length;
  return (
    <View style={styles.allControls} testID="factory-all-controls">
      <Text style={styles.muted}>
        {t("projectFactory.scope.summary", {
          count: data.factories.length,
          running,
          paused: data.factories.length - running,
        })}
      </Text>
      {stop}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Needs you

const COMPACT_ROWS = 4;

/**
 * Everything waiting on the owner. Empty, it is one quiet line; otherwise a count and the most
 * urgent rows, with the rest one press away.
 */
export function NeedsYouPanel({
  data,
  expanded: startExpanded = false,
}: {
  data: FactoryOverviewData;
  expanded?: boolean;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  // Phones start folded so the board stays within reach.
  const [expanded, setExpanded] = useState(startExpanded && !compact);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const items = data.needsYou;
  if (items.length === 0) {
    return (
      <View style={styles.quiet} testID="factory-needs-you-empty">
        <Text style={styles.muted}>{t("projectFactory.needsYou.none")}</Text>
        {data.sample ? <SampleTag /> : null}
      </View>
    );
  }
  const shown = expanded ? items : items.slice(0, COMPACT_ROWS);
  return (
    <View style={styles.panel} testID="factory-needs-you">
      <View style={styles.panelHeader}>
        <Text style={styles.panelTitle}>{t("projectFactory.needsYou.title")}</Text>
        <StatusBadge size="xs" variant="warning" label={String(items.length)} />
        <View style={styles.spacer} />
        {data.sample ? <SampleTag /> : null}
      </View>
      <View>
        {shown.map((item) => (
          <NeedsYouRow key={item.key} item={item} data={data} />
        ))}
      </View>
      {items.length > COMPACT_ROWS ? (
        <Button variant="ghost" size="sm" onPress={toggle} testID="factory-needs-you-toggle">
          {expanded
            ? t("projectFactory.needsYou.showFewer")
            : t("projectFactory.needsYou.showAll", { count: items.length })}
        </Button>
      ) : null}
    </View>
  );
}

function needsYouSubject(item: NeedsYouItem): string {
  return item.number !== null ? `#${item.number} ${item.subject}` : item.subject;
}

function NeedsYouRow({ item, data }: { item: NeedsYouItem; data: FactoryOverviewData }) {
  const { t } = useTranslation();
  const date = useMemo(() => (item.at ? new Date(item.at) : null), [item.at]);
  const age = useTimeAgo(date);
  const { stopAll } = data;
  const act = useCallback(() => {
    const { action } = item;
    switch (action.kind) {
      case "thread":
        navigateToAgent({ serverId: action.serverId, agentId: action.agentId });
        return;
      case "issue": {
        const viaPr = item.kind === "failingChecks" || item.kind === "awaitingApproval";
        const url = viaPr && action.prUrl ? action.prUrl : action.url;
        void openExternalUrl(url).catch(console.error);
        return;
      }
      case "instructions":
        openFactoryInstructions({
          serverId: action.serverId,
          projectId: action.projectId,
          role: action.role,
        });
        return;
      case "resumeAll":
        stopAll.resume(action.serverId);
    }
  }, [item, stopAll]);
  const compact = useIsCompactFormFactor();
  const summary = t(`projectFactory.needsYou.kinds.${item.kind}`, {
    subject: needsYouSubject(item),
  });
  const actionLabel = t(`projectFactory.needsYou.actions.${item.action.kind}`);
  const ageLabel = date ? age : "—";
  return (
    <PressHighlight
      onPress={act}
      disabled={data.sample}
      accessibilityRole="button"
      accessibilityLabel={summary}
      style={styles.row}
      testID={`factory-needs-you-${item.kind}`}
    >
      <ThemedIcon icon={item.kind} />
      {compact ? (
        <View style={styles.rowStack}>
          <Text style={styles.rowText} numberOfLines={2}>
            {summary}
          </Text>
          <Text style={styles.muted} numberOfLines={1}>
            {[data.scope === "all" ? item.projectLabel : null, ageLabel, actionLabel]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
      ) : (
        <>
          <Text style={styles.rowText} numberOfLines={1}>
            {summary}
          </Text>
          {data.scope === "all" ? (
            <Text style={styles.rowProject} numberOfLines={1}>
              {item.projectLabel}
            </Text>
          ) : null}
          <Text style={styles.rowAge}>{ageLabel}</Text>
          <Text style={styles.rowAction}>{actionLabel}</Text>
        </>
      )}
    </PressHighlight>
  );
}

// ---------------------------------------------------------------------------------------------
// Per-Factory strip

/** One card or rail row per Factory, with its state, stage counts, needs-you count and zoom. */
export function FactoriesStrip({
  data,
  layout = "cards",
  selected,
  onSelect,
}: {
  data: FactoryOverviewData;
  layout?: "cards" | "rail";
  selected?: string | null;
  onSelect?: (key: string | null) => void;
}) {
  const counts = useMemo(() => needsYouByFactory(data.needsYou), [data.needsYou]);
  return (
    <View style={layout === "rail" ? styles.railList : styles.cards} testID="factory-strip">
      {data.factories.map((entry) => (
        <FactoryTile
          key={entry.key}
          entry={entry}
          needsYou={counts.get(entry.key) ?? 0}
          layout={layout}
          selected={selected === entry.key}
          onSelect={onSelect}
          zoomIn={data.zoomIn}
          sample={data.sample}
        />
      ))}
    </View>
  );
}

function FactoryTile({
  entry,
  needsYou,
  layout,
  selected,
  onSelect,
  zoomIn,
  sample,
}: {
  entry: FactoryScopeEntry;
  needsYou: number;
  layout: "cards" | "rail";
  selected: boolean;
  onSelect?: (key: string | null) => void;
  zoomIn: (serverId: string, projectId: string) => void;
  sample: boolean;
}) {
  const { t } = useTranslation();
  const pill = factoryStatePill({ state: entry.status, drain: entry.drain ?? entry.state?.drain });
  const zoom = useCallback(
    () => zoomIn(entry.serverId, entry.projectId),
    [entry.projectId, entry.serverId, zoomIn],
  );
  const select = useCallback(
    () => onSelect?.(selected ? null : entry.key),
    [entry.key, onSelect, selected],
  );
  const zoomButton = (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={ZoomIn}
      onPress={zoom}
      disabled={sample}
      accessibilityLabel={t("projectFactory.scope.zoomIn", { project: entry.name })}
      testID={`factory-zoom-${entry.projectId}`}
    >
      {layout === "rail" ? null : t("projectFactory.scope.open")}
    </Button>
  );
  const body = (
    <>
      <View style={styles.tileHeader}>
        <Text style={styles.tileName} numberOfLines={1}>
          {entry.name}
        </Text>
        <StatusBadge
          size="xs"
          variant={pill.variant}
          label={t(`projectFactory.scope.states.${pill.label}`)}
        />
      </View>
      {entry.hostLabel ? (
        <Text style={styles.muted} numberOfLines={1}>
          {entry.hostLabel}
        </Text>
      ) : null}
      <MiniStages entry={entry} />
      <Text style={needsYou ? styles.needsCount : styles.muted}>
        {needsYou
          ? t("projectFactory.needsYou.count", { count: needsYou })
          : t("projectFactory.needsYou.none")}
      </Text>
    </>
  );
  if (layout === "rail") {
    return (
      <View style={[styles.railRow, selected && styles.railSelected]}>
        <PressHighlight
          onPress={select}
          accessibilityRole="tab"
          accessibilityState={selected ? SELECTED : UNSELECTED}
          style={styles.railBody}
          testID={`factory-filter-${entry.projectId}`}
        >
          {body}
        </PressHighlight>
        {zoomButton}
      </View>
    );
  }
  return (
    <View style={styles.tile} testID={`factory-tile-${entry.projectId}`}>
      {body}
      <View style={styles.tileFooter}>{zoomButton}</View>
    </View>
  );
}

const SELECTED = { selected: true };
const UNSELECTED = { selected: false };

/** Issues per stage as a thin bar of proportional segments, colored like the lane stripes. */
function MiniStages({ entry }: { entry: FactoryScopeEntry }) {
  const { t } = useTranslation();
  const counts = useMemo(() => aggregateStageCounts([entry.issues]), [entry.issues]);
  const total = FACTORY_LANES.reduce((sum, lane) => sum + counts[lane], 0);
  if (entry.issues === null) return <Text style={styles.muted}>—</Text>;
  if (total === 0) return <Text style={styles.muted}>{t("projectFactory.idle")}</Text>;
  return (
    <View style={styles.mini}>
      {FACTORY_LANES.filter((lane) => counts[lane] > 0).map((lane) => (
        <View key={lane} style={styles.miniItem}>
          <StageRing lane={lane} />
          <Text style={styles.miniCount}>{counts[lane]}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  spacer: { flex: 1 },
  allControls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  banners: { gap: theme.spacing[2] },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
  },
  bannerText: { flex: 1, minWidth: 200, gap: 2 },
  bannerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  quiet: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    minHeight: 24,
  },
  panel: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
  },
  panelTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 34,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    ...hoverStyle({ backgroundColor: theme.colors.interactionHighlight }),
  },
  rowStack: { flex: 1, minWidth: 0, gap: 2, paddingVertical: theme.spacing[1.5] },
  rowText: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  rowProject: {
    maxWidth: 140,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rowAge: {
    width: 56,
    textAlign: "right",
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  rowAction: {
    width: 64,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  cards: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  tile: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 240,
    maxWidth: 420,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[3],
    gap: theme.spacing[1.5],
  },
  tileHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  tileName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  tileFooter: { flexDirection: "row", justifyContent: "flex-end" },
  needsCount: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  mini: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2], minHeight: 18 },
  miniItem: { flexDirection: "row", alignItems: "center", gap: 3 },
  miniCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  railList: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    paddingVertical: theme.spacing[1],
  },
  railRow: {
    flexDirection: "row",
    alignItems: "center",
    borderLeftWidth: 2,
    borderLeftColor: "transparent",
    paddingRight: theme.spacing[1],
  },
  railSelected: {
    borderLeftColor: theme.colors.accent,
    backgroundColor: theme.colors.interactionHighlight,
  },
  railBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
}));
