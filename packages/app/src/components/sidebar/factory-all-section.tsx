import { useQueryClient } from "@tanstack/react-query";
import { SidebarFactoryIcon, SidebarLeadingSlot } from "./leading-slot";
import { sidebarContainerRowStyles } from "./container-row";
import { sidebarIndentStyle } from "./indent";
import { useSidebarRowDensity } from "./use-sidebar-row-density";
import { hoverStyle, rowSurface } from "@/styles/hover";
import { useVortonTouch } from "@/vorton-touch";
import { memo, useCallback, useMemo } from "react";
import { Text, View, type GestureResponderEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { router, usePathname, type Href } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowRight } from "lucide-react-native";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useFetchQueries } from "@/data/query";
import { projectNameForWorkspace } from "@/hooks/sidebar-workspaces-view-model";
import { useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { useHosts } from "@/runtime/host-runtime";
import { allFactoriesOverviewRoute } from "@/screens/factory/routes";
import {
  factoryQueueRefreshInterval,
  loadFactoryQueue,
  type FactoryQueue,
} from "@/screens/factory/queue";
import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { ProjectFactoryList } from "../../../../../plugins/factory/shared/project";
import {
  boundedFactoryRead,
  factoryQueueNeedsInitialRead,
  factoryListQueryKey,
  loadFactoryList,
} from "@/screens/factory/factory-reads";
import { factoryCardReadsQueue } from "./factory-section";
import { factoryOverviewPathTarget, factoryPipelineCounts } from "./factory-card-model";
import {
  aggregateFactories,
  factorySummaryState,
  isListedFactory,
  type FactorySummaryInput,
} from "./factory-global-model";

const SELECTED_STATE = { selected: true };

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

/**
 * Every Factory on every connected host, read through the same query keys as the project cards
 * and the overview, so the caches are shared and nothing is read twice.
 */
function useAllFactories(collapsed: boolean) {
  const active = useRetainedPanelActive();
  const queryClient = useQueryClient();
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
      queryFn: () => loadFactoryList(plugin.invoke),
    })),
  );
  const listed = useMemo(
    () =>
      factoryPlugins.flatMap((plugin, index): ListedFactory[] =>
        (lists[index]?.data?.projects ?? [])
          .filter(isListedFactory)
          .map((project) => ({ project, plugin })),
      ),
    [factoryPlugins, lists],
  );
  const queues = useFetchQueries(
    listed.map(({ project, plugin }) => ({
      dataShape: "value" as const,
      staleTimeMs: 30_000,
      queryKey: ["factoryQueue", plugin.serverId, project.projectId],
      // A paused Factory reads once to recover its last snapshot, then stays quiet.
      enabled:
        factoryCardReadsQueue({ active, collapsed, state: project }) ||
        (active &&
          factoryQueueNeedsInitialRead(
            queryClient.getQueryState(["factoryQueue", plugin.serverId, project.projectId]),
          )) ||
        (active &&
          queryClient.getQueryData<FactoryQueue | null>([
            "factoryQueue",
            plugin.serverId,
            project.projectId,
          ])?.refreshing === true),
      refetchInterval: (query: { state: { data: FactoryQueue | null | undefined } }) =>
        factoryQueueRefreshInterval({
          queue: query.state.data,
          enabled: active,
          polling: factoryCardReadsQueue({ active, collapsed, state: project }),
        }),
      queryFn: () =>
        boundedFactoryRead(() => loadFactoryQueue(plugin.invoke, project.projectId), {
          priority: "summary",
        }),
      retry: false,
    })),
  );
  // Only the names it shows: a whole-sessions subscription re-ran this on every stream event.
  const projectNames = useSessionStore(
    useShallow((store) =>
      listed.map(({ project, plugin }) =>
        factoryProjectName(store.sessions[plugin.serverId], project.projectId),
      ),
    ),
  );
  const hosts = useHosts();
  const factories = useMemo((): FactorySummaryInput[] => {
    const multiHost = new Set(listed.map(({ plugin }) => plugin.serverId)).size > 1;
    return listed.map(({ project, plugin }, index) => {
      const serverId = plugin.serverId;
      return {
        serverId,
        projectId: project.projectId,
        projectName: projectNames[index] ?? project.projectId,
        hostLabel: multiHost
          ? (hosts.find((host) => host.serverId === serverId)?.label ?? serverId)
          : null,
        listed: project,
        issues: queues[index]?.data?.issues ?? null,
      };
    });
  }, [listed, queues, projectNames, hosts]);
  const errors = useMemo(
    () => [
      ...lists.filter((list) => list.isError),
      ...queues.filter((queue) => queue.isError || queue.data?.error),
    ],
    [lists, queues],
  );
  const retry = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void Promise.all(errors.map((queue) => queue.refetch()));
    },
    [errors],
  );
  const visible = factoryPlugins.length > 0 && (factories.length > 0 || errors.length > 0);
  const degraded = queues.map((query) => query.data?.degraded).find(Boolean);
  return { factories, errors, retry, visible, degraded };
}

/** A three-line global pipeline summary. The whole block opens the overview. */
export const AllFactoriesSection = memo(function AllFactoriesSection({
  mainSidebar = true,
  focused = false,
  onBeforeNavigate,
}: {
  mainSidebar?: boolean;
  focused?: boolean;
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const { factories, errors, retry, visible, degraded } = useAllFactories(false);
  const density = useSidebarRowDensity();
  const touch = useVortonTouch();
  const aggregate = useMemo(() => aggregateFactories(factories), [factories]);
  const pipeline = useMemo(() => factoryPipelineCounts(aggregate.issues), [aggregate.issues]);
  const firstServerId = factories[0]?.serverId ?? null;
  const routeTarget = factoryOverviewPathTarget(usePathname());
  const openOverview = useCallback(() => {
    if (!firstServerId) return;
    onBeforeNavigate?.();
    router.navigate(allFactoriesOverviewRoute(firstServerId) as Href);
  }, [firstServerId, onBeforeNavigate]);
  if (!mainSidebar || focused || !visible) return null;
  const summary = factorySummaryState(factories);
  const anyQueue = summary.hasQueue;
  const selected = routeTarget !== null && routeTarget.projectId === null;
  return (
    <PressHighlight
      onPress={openOverview}
      accessibilityRole="link"
      accessibilityLabel={t("sidebar.factoryCard.allTitle")}
      accessibilityState={selected ? SELECTED_STATE : undefined}
      // One surface for the whole block: the folder row's geometry, hover and selected fills.
      style={[
        sidebarContainerRowStyles.row,
        density,
        sidebarIndentStyle(0),
        styles.summary,
        selected ? styles.selected : !touch && styles.hoverable,
      ]}
      highlightStyle={sidebarContainerRowStyles.rowPressed}
      testID="factory-global-summary"
    >
      <View style={styles.heading}>
        <SidebarLeadingSlot chevron={null}>{factoryIcon}</SidebarLeadingSlot>
        <Text
          style={[
            sidebarContainerRowStyles.title,
            selected ? styles.selectedTitle : sidebarContainerRowStyles.calmTitle,
            styles.title,
          ]}
          numberOfLines={1}
        >
          {t("sidebar.factoryCard.allTitle")}
        </Text>
        <ThemedArrowRight size={14} uniProps={calmColor} />
      </View>
      <View style={styles.details}>
        <Text style={styles.counts} numberOfLines={1}>
          {t("projectFactory.scope.sidebarSummary", summary)}
        </Text>
        <Text style={styles.counts} numberOfLines={1}>
          {anyQueue ? t("projectFactory.scope.pipelineSummary", pipeline) : null}
        </Text>
        {degraded ? <Text style={styles.counts}>{degraded}</Text> : null}
        {errors.length > 0 ? (
          <PressHighlight onPress={retry} accessibilityRole="button">
            <Text style={styles.counts}>{t("projectFactory.scope.queueRetry")}</Text>
          </PressHighlight>
        ) : null}
      </View>
    </PressHighlight>
  );
});

const calmColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const ThemedArrowRight = withUnistyles(ArrowRight);
// Calm like the Pinned and Factory glyphs below it.
const factoryIcon = <SidebarFactoryIcon calm cssHover />;
const styles = StyleSheet.create((theme) => ({
  // A column on the folder row's rails; it grows with its lines instead of centering one.
  summary: { flexDirection: "column", alignItems: "stretch", gap: theme.spacing[0.5] },
  hoverable: hoverStyle({ backgroundColor: theme.colors.surfaceSidebarHover }),
  selected: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
    ...rowSurface(theme.colors.surfaceSidebarSelected),
  },
  selectedTitle: { color: theme.colors.foreground },
  heading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: { flex: 1 },
  // Lines start under the title: the leading slot plus the heading's gap.
  details: { marginLeft: theme.iconSize.md + theme.spacing[2], gap: theme.spacing[0.5] },
  counts: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
