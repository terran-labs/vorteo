import { memo, useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { router, usePathname, type Href } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Activity } from "lucide-react-native";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { PressHighlight } from "@/components/ui/press-highlight";
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
  FactorySectionRow,
  factoryCardReadsQueue,
} from "./factory-section";
import { factoryCardKey, factoryOverviewPathTarget } from "./factory-card-model";
import { factoryChipStyles, factoryTileRowStyle } from "./factory-card-roles";
import { FactorySubheading } from "./factory-subheading";
import { FactoryRunners } from "./factory-card-runners";
import { useFactoryCardStore } from "./factory-card-store";
import {
  aggregateFactories,
  isListedFactory,
  type FactoryChipSummary,
  type FactorySummaryInput,
} from "./factory-global-model";
import { ProjectFactoryStateSchema, type ProjectFactoryState } from "./factory-state";
import { factoryOverviewRoute } from "./project-factory-model";

const SELECTED_STATE = { selected: true };

/** A root section, like Pinned. */
const ALL_FACTORIES_LEVEL = 0;

/** The device-store key for the All Factories card's collapse state. */
export const ALL_FACTORIES_CARD_KEY = "all";

/** Factory state and list reads are local daemon reads, refreshed like the project cards. */
const STATE_REFRESH_MS = 60_000;

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
  return { factories, plugins: factoryPlugins };
}

/**
 * Every project's Factory summed into one card above Pinned, shaped like a project's Factory card:
 * per-Factory chips replace the role chips, and runners carry their project.
 */
export const AllFactoriesSection = memo(function AllFactoriesSection({
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
  const { factories, plugins } = useAllFactories(collapsed);
  const aggregate = useMemo(() => aggregateFactories(factories), [factories]);
  const firstServerId = factories[0]?.serverId ?? null;
  // All Factories is selected on its own overview; a project overview selects that project's chip.
  const routeTarget = factoryOverviewPathTarget(usePathname());
  const openOverview = useCallback(() => {
    if (!firstServerId) return;
    onBeforeNavigate?.();
    router.navigate(allFactoriesOverviewRoute(firstServerId) as Href);
  }, [firstServerId, onBeforeNavigate]);
  if (!mainSidebar || focused || factories.length === 0) return null;
  // Show the queue once any Factory has reported one; hide it while none has.
  const anyQueue = factories.some((factory) => factory.issues !== null);
  return (
    <FactorySectionRow
      sectionKey={ALL_FACTORIES_CARD_KEY}
      level={ALL_FACTORIES_LEVEL}
      title={t("sidebar.factoryCard.allTitle")}
      pill={null}
      issues={anyQueue ? aggregate.issues : null}
      onOpenOverview={firstServerId ? openOverview : null}
      selected={routeTarget !== null && routeTarget.projectId === null}
      pinnable={false}
    >
      {aggregate.chips.length > 0 ? (
        <>
          <FactorySubheading
            label={t("sidebar.factoryCard.factories")}
            level={ALL_FACTORIES_LEVEL + 1}
          />
          <FactorySummaryChips
            chips={aggregate.chips}
            level={ALL_FACTORIES_LEVEL + 2}
            selectedKey={
              routeTarget?.projectId
                ? factoryCardKey(routeTarget.serverId, routeTarget.projectId)
                : null
            }
            plugins={plugins}
            onBeforeNavigate={onBeforeNavigate}
          />
        </>
      ) : null}
      <FactoryRunners
        runners={aggregate.runners}
        level={ALL_FACTORIES_LEVEL + 1}
        onBeforeNavigate={onBeforeNavigate}
      />
    </FactorySectionRow>
  );
});

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedActivity = withUnistyles(Activity);
const inFlightIcon = <ThemedActivity size={11} uniProps={mutedColor} />;

/** One chip per Factory, standing in for the role chips; each zooms into its project. */
function FactorySummaryChips({
  chips,
  level,
  selectedKey,
  plugins,
  onBeforeNavigate,
}: {
  chips: readonly FactoryChipSummary[];
  level: number;
  /** The chip whose project overview is the current page. */
  selectedKey: string | null;
  plugins: readonly InstalledPlugin[];
  onBeforeNavigate?: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <View
      pointerEvents="box-none"
      style={[factoryChipStyles.grid, factoryTileRowStyle(level)]}
      testID="factory-card-factories"
    >
      {chips.map((chip) => (
        <View key={chip.key} pointerEvents="box-none" style={factoryChipStyles.cell}>
          <FactorySummaryChip
            chip={chip}
            selected={chip.key === selectedKey}
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
  selected,
  plugin,
  onBeforeNavigate,
}: {
  chip: FactoryChipSummary;
  selected: boolean;
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
            })}
            accessibilityState={selected ? SELECTED_STATE : undefined}
            aria-current={selected ? "page" : undefined}
            disabled={!route}
            onPress={open}
            style={[
              factoryChipStyles.chip,
              touch && factoryChipStyles.chipTouch,
              selected ? factoryChipStyles.chipSelected : factoryChipStyles.chipHoverable,
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
          </PressHighlight>
        </View>
      </TooltipTrigger>
      <TooltipContent side="top" maxWidth={300}>
        <TooltipText
          label={`${name} · ${state}`}
          description={[
            chip.held && chip.reason
              ? t("sidebar.factoryCard.heldReason", { reason: chip.reason })
              : chip.reason,
            t("sidebar.factoryCard.inFlight", { count: chip.inFlight }),
          ]
            .filter(Boolean)
            .join("\n")}
        />
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
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
  countGroup: { flexDirection: "row", alignItems: "center", gap: 2 },
}));

const dotStyle = { success: styles.success, warning: styles.warning, muted: styles.muted };
