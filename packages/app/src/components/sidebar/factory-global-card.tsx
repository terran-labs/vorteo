import { memo, useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { router, type Href } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Activity, CircleAlert } from "lucide-react-native";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { isNative } from "@/constants/platform";
import { useFetchQueries } from "@/data/query";
import { projectNameForWorkspace } from "@/hooks/sidebar-workspaces-view-model";
import { useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { useHosts } from "@/runtime/host-runtime";
import { allFactoriesOverviewRoute } from "@/screens/factory/routes";
import { loadFactoryQueue, type FactoryQueue } from "@/screens/factory/queue";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { useVortonTouch } from "@/vorton-touch";
import type { ProjectFactoryList } from "../../../../../plugins/factory/shared/project";
import {
  boundedFactoryRead,
  factoryListQueryKey,
  loadFactoryList,
} from "@/screens/factory/factory-reads";
import {
  FACTORY_CARD_QUEUE_REFRESH_MS,
  FactoryCardFrame,
  factoryCardReadsQueue,
} from "./factory-card";
import { factoryCardPassThrough } from "./factory-card-hover";
import { factoryChipStyles } from "./factory-card-roles";
import { FactoryRunners } from "./factory-card-runners";
import { useFactoryCardStore } from "./factory-card-store";
import {
  aggregateFactories,
  isListedFactory,
  type FactoryChipSummary,
  type FactorySummaryInput,
} from "./factory-global-model";
import {
  collectNeedsYou,
  factoryScopeKey,
  type FactoryScopeEntry,
  type NeedsYouItem,
} from "@/screens/factory/all-factories-model";
import { useFactoryQuestions } from "@/screens/factory/overview-sources";
import { ProjectFactoryStateSchema, type ProjectFactoryState } from "./factory-state";
import { factoryOverviewRoute } from "./project-factory-model";

/** The device-store key for the All Factories card's collapse state. */
export const ALL_FACTORIES_CARD_KEY = "all";

/** Factory state and list reads are local daemon reads, refreshed like the project cards. */
const STATE_REFRESH_MS = 60_000;
const MAX_NEEDS_YOU_LINES = 8;

interface ListedFactory {
  project: ProjectFactoryList["projects"][number];
  plugin: InstalledPlugin;
}

type SessionSnapshot = ReturnType<typeof useSessionStore.getState>["sessions"][string];

function factoryProjectName(session: SessionSnapshot | undefined, projectId: string): string {
  const member = Array.from(session?.workspaces.values() ?? []).find(
    (workspace) => workspace.projectId === projectId,
  );
  if (member) return projectNameForWorkspace(member);
  const stored = session?.projects.get(projectId);
  return stored?.projectCustomName ?? stored?.projectDisplayName ?? projectId;
}

function combineData<T>(results: { data?: T }[]): (T | undefined)[] {
  return results.map((result) => result.data);
}

/**
 * Every Factory on every connected host, read through the same query keys as the project cards
 * and the overview, so the caches are shared and nothing is read twice.
 */
function useAllFactories(collapsed: boolean) {
  const active = useRetainedPanelActive();
  const plugins = useInstalledPlugins();
  const factoryPlugins = useMemo(
    () => plugins.filter((plugin) => plugin.id === "factory"),
    [plugins],
  );
  const lists = useFetchQueries(
    factoryPlugins.map((plugin) => ({
      dataShape: "value" as const,
      staleTimeMs: 30_000,
      queryKey: factoryListQueryKey(plugin.serverId),
      enabled: active,
      refetchInterval: active ? STATE_REFRESH_MS : false,
      queryFn: () => boundedFactoryRead(() => loadFactoryList(plugin.invoke)),
    })),
    combineData<ProjectFactoryList>,
  );
  const listed = useMemo(
    () =>
      factoryPlugins.flatMap((plugin, index): ListedFactory[] =>
        (lists[index]?.projects ?? [])
          .filter(isListedFactory)
          .map((project) => ({ project, plugin })),
      ),
    [factoryPlugins, lists],
  );
  const states = useFetchQueries(
    listed.map(({ project, plugin }) => ({
      dataShape: "value" as const,
      staleTimeMs: 30_000,
      queryKey: ["projectFactory", plugin.serverId, project.projectId],
      enabled: active,
      refetchInterval: active ? STATE_REFRESH_MS : false,
      queryFn: () =>
        boundedFactoryRead(async () =>
          ProjectFactoryStateSchema.parse(
            await plugin.invoke("factory.project.get", { projectId: project.projectId }),
          ),
        ),
    })),
    combineData<ProjectFactoryState>,
  );
  const queues = useFetchQueries(
    listed.map(({ project, plugin }) => ({
      dataShape: "value" as const,
      staleTimeMs: 30_000,
      queryKey: ["factoryQueue", plugin.serverId, project.projectId],
      enabled: factoryCardReadsQueue({ active, collapsed, state: project }),
      refetchInterval: (query: { state: { data: unknown } }) =>
        query.state.data !== null ? FACTORY_CARD_QUEUE_REFRESH_MS : false,
      queryFn: () => boundedFactoryRead(() => loadFactoryQueue(plugin.invoke, project.projectId)),
    })),
    combineData<FactoryQueue | null>,
  );
  const sessions = useSessionStore((store) => store.sessions);
  const hosts = useHosts();
  const factories = useMemo((): FactorySummaryInput[] => {
    const multiHost = new Set(listed.map(({ plugin }) => plugin.serverId)).size > 1;
    return listed.map(({ project, plugin }, index) => {
      const serverId = plugin.serverId;
      const session = sessions[serverId];
      return {
        serverId,
        projectId: project.projectId,
        projectName: factoryProjectName(session, project.projectId),
        hostLabel: multiHost
          ? (hosts.find((host) => host.serverId === serverId)?.label ?? serverId)
          : null,
        listed: project,
        state: states[index],
        issues: queues[index]?.issues ?? null,
      };
    });
  }, [listed, states, queues, sessions, hosts]);
  // The overview's needs-you model, so the card and the overview count the same things.
  const entries = useMemo(
    (): FactoryScopeEntry[] =>
      factories.map((factory, index) => ({
        key: factoryScopeKey(factory.serverId, factory.projectId),
        serverId: factory.serverId,
        projectId: factory.projectId,
        name: factory.projectName,
        hostLabel: factory.hostLabel,
        state: states[index] ?? null,
        status: factory.listed.state,
        drain: factory.listed.drain,
        issues: factory.issues ? [...factory.issues] : null,
      })),
    [factories, states],
  );
  const questions = useFactoryQuestions(entries);
  const needsYou = useMemo(() => collectNeedsYou({ entries, questions }), [entries, questions]);
  return { factories, needsYou, plugins: factoryPlugins };
}

/**
 * Every project's Factory summed into one card above Pinned, shaped like a project's Factory card:
 * per-Factory chips replace the role chips, and runners carry their project.
 */
export const AllFactoriesCard = memo(function AllFactoriesCard({
  mainSidebar = true,
  focused = false,
  onBeforeNavigate,
}: {
  /** False in a single project's rail flyout, which has no global section. */
  mainSidebar?: boolean;
  /** A sidebar focus hides the root sections, as it hides Pinned. */
  focused?: boolean;
  /** Lets a host surface such as the rail flyout close before navigation. */
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const collapsed = useFactoryCardStore((state) =>
    state.collapsed.includes(ALL_FACTORIES_CARD_KEY),
  );
  const { factories, needsYou, plugins } = useAllFactories(collapsed);
  const aggregate = useMemo(() => aggregateFactories(factories, needsYou), [factories, needsYou]);
  const firstServerId = factories[0]?.serverId ?? null;
  const openOverview = useCallback(() => {
    if (!firstServerId) return;
    onBeforeNavigate?.();
    router.navigate(allFactoriesOverviewRoute(firstServerId) as Href);
  }, [firstServerId, onBeforeNavigate]);
  const pill = useMemo(
    () => ({
      pill: aggregate.pill,
      description: aggregate.chips
        .map((chip) =>
          t("sidebar.factoryCard.stateSummary", {
            project: chip.hostLabel ? `${chip.name} · ${chip.hostLabel}` : chip.name,
            state: t(`sidebar.factoryCard.states.${chip.pill.label}`),
          }),
        )
        .join("\n"),
    }),
    [aggregate, t],
  );
  const badge = useMemo(
    () =>
      aggregate.needsYou.length > 0 ? (
        <NeedsYouBadge items={aggregate.needsYou} onPress={openOverview} />
      ) : null,
    [aggregate.needsYou, openOverview],
  );
  if (!mainSidebar || focused || factories.length === 0) return null;
  // Show the queue once any Factory has reported one; hide it while none has.
  const anyQueue = factories.some((factory) => factory.issues !== null);
  return (
    <FactoryCardFrame
      cardKey={ALL_FACTORIES_CARD_KEY}
      level={0}
      title={t("sidebar.factoryCard.allTitle")}
      subtitle={null}
      pill={pill}
      badge={badge}
      issues={anyQueue ? aggregate.issues : null}
      onOpenOverview={firstServerId ? openOverview : null}
      pinnable={false}
    >
      <FactorySummaryChips
        chips={aggregate.chips}
        plugins={plugins}
        onBeforeNavigate={onBeforeNavigate}
      />
      <FactoryRunners runners={aggregate.runners} onBeforeNavigate={onBeforeNavigate} />
    </FactoryCardFrame>
  );
});

const warningColor = (theme: Theme) => ({ color: theme.colors.statusWarning });
const ThemedCircleAlert = withUnistyles(CircleAlert);
const needsYouIcon = <ThemedCircleAlert size={11} uniProps={warningColor} />;
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedActivity = withUnistyles(Activity);
const inFlightIcon = <ThemedActivity size={11} uniProps={mutedColor} />;

function needsYouLine(t: ReturnType<typeof useTranslation>["t"], item: NeedsYouItem): string {
  const subject = item.number !== null ? `#${item.number} ${item.subject}` : item.subject;
  const text = t(`projectFactory.needsYou.kinds.${item.kind}`, { subject });
  return `${text} · ${item.projectLabel}`;
}

/** What waits on the owner across every Factory; opens the overview like the card. */
function NeedsYouBadge({
  items,
  onPress,
}: {
  items: readonly NeedsYouItem[];
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const shown = items.slice(0, MAX_NEEDS_YOU_LINES);
  const more = items.length - shown.length;
  const lines = shown.map((item) => ({
    key: item.key,
    text: needsYouLine(t, item),
  }));
  if (more > 0)
    lines.push({ key: "more", text: t("sidebar.factoryCard.moreIssues", { count: more }) });
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger
        accessible={false}
        focusable={false}
        tabIndex={-1}
        aria-hidden
        onPress={onPress}
        style={styles.passThrough}
        testID="factory-card-needs-you"
      >
        <StatusBadge
          label={String(items.length)}
          variant="warning"
          size="xs"
          leading={needsYouIcon}
        />
      </TooltipTrigger>
      <TooltipContent side="top" maxWidth={340}>
        <View style={styles.tooltipBody}>
          <Text style={styles.tooltipHeader}>
            {t("sidebar.factoryCard.needsYouHeader", { count: items.length })}
          </Text>
          {lines.map((line) => (
            <Text key={line.key} style={styles.tooltipLine} numberOfLines={2}>
              {line.text}
            </Text>
          ))}
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

/** One chip per Factory, standing in for the role chips; each zooms into its project. */
function FactorySummaryChips({
  chips,
  plugins,
  onBeforeNavigate,
}: {
  chips: readonly FactoryChipSummary[];
  plugins: readonly InstalledPlugin[];
  onBeforeNavigate?: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={factoryChipStyles.grid} testID="factory-card-factories">
      {chips.map((chip) => (
        <View key={chip.key} pointerEvents="box-none" style={factoryChipStyles.cell}>
          <FactorySummaryChip
            chip={chip}
            plugin={plugins.find((plugin) => plugin.serverId === chip.serverId)}
            onBeforeNavigate={onBeforeNavigate}
          />
        </View>
      ))}
    </View>
  );
}

function FactorySummaryChip({
  chip,
  plugin,
  onBeforeNavigate,
}: {
  chip: FactoryChipSummary;
  plugin: InstalledPlugin | undefined;
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const touch = useVortonTouch() || isNative;
  const route = useMemo(
    () =>
      factoryOverviewRoute(
        {
          serverId: chip.serverId,
          projectId: chip.projectId,
          installationId: `project-factory:${chip.projectId}`,
        },
        plugin,
      ),
    [chip.serverId, chip.projectId, plugin],
  );
  const open = useCallback(() => {
    if (!route) return;
    onBeforeNavigate?.();
    router.navigate(route);
  }, [route, onBeforeNavigate]);
  const name = chip.hostLabel ? `${chip.name} · ${chip.hostLabel}` : chip.name;
  const state = t(`sidebar.factoryCard.states.${chip.pill.label}`);
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <View collapsable={false}>
          <PressHighlight
            accessibilityRole="link"
            accessibilityLabel={t("sidebar.factoryCard.openProject", { project: name })}
            accessibilityHint={t("sidebar.factoryCard.chipCounts", {
              state,
              inFlight: chip.inFlight,
              needsYou: chip.needsYou,
            })}
            disabled={!route}
            onPress={open}
            style={[
              factoryChipStyles.chip,
              touch && factoryChipStyles.chipTouch,
              factoryChipStyles.chipHoverable,
            ]}
            highlightStyle={factoryChipStyles.chipPressed}
            testID={`factory-card-factory-${chip.key}`}
          >
            <View style={styles.dotSlot}>
              <View style={[styles.dot, dotStyle[chip.pill.variant]]} />
            </View>
            <Text style={factoryChipStyles.chipText} numberOfLines={1}>
              {name}
            </Text>
            {chip.inFlight > 0 ? (
              <View style={styles.countGroup}>
                {inFlightIcon}
                <Text style={styles.count}>{chip.inFlight}</Text>
              </View>
            ) : null}
            {chip.needsYou > 0 ? (
              <View style={styles.countGroup}>
                {needsYouIcon}
                <Text style={[styles.count, styles.needsYouCount]}>{chip.needsYou}</Text>
              </View>
            ) : null}
          </PressHighlight>
        </View>
      </TooltipTrigger>
      <TooltipContent side="top" maxWidth={300}>
        <TooltipText
          label={`${name} · ${state}`}
          description={[
            chip.held && chip.reason
              ? t("projectFactory.needsYou.kinds.held", { subject: chip.reason })
              : chip.reason,
            t("sidebar.factoryCard.chipCountsShort", {
              inFlight: chip.inFlight,
              needsYou: chip.needsYou,
            }),
          ]
            .filter(Boolean)
            .join("\n")}
        />
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  passThrough: { flexShrink: 0, ...factoryCardPassThrough },
  tooltipBody: { gap: 2 },
  tooltipHeader: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  tooltipLine: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  dotSlot: { minWidth: 16, alignItems: "center", justifyContent: "center" },
  dot: { width: 7, height: 7, borderRadius: theme.borderRadius.full },
  success: { backgroundColor: theme.colors.statusSuccess },
  warning: { backgroundColor: theme.colors.statusWarning },
  muted: { backgroundColor: theme.colors.foregroundExtraMuted },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  needsYouCount: { color: theme.colors.statusWarning },
  countGroup: { flexDirection: "row", alignItems: "center", gap: 2 },
}));

const dotStyle = { success: styles.success, warning: styles.warning, muted: styles.muted };
