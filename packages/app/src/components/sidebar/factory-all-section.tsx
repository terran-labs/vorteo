import { SidebarFactoryIcon } from "./leading-slot";
import { FactoryStageBar } from "./factory-card-stage-bar";
import { memo, useCallback, useMemo } from "react";
import { Text, View } from "react-native";
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
import { loadFactoryQueue, type FactoryQueue } from "@/screens/factory/queue";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { ProjectFactoryList } from "../../../../../plugins/factory/shared/project";
import {
  boundedFactoryRead,
  factoryListQueryKey,
  loadFactoryList,
} from "@/screens/factory/factory-reads";
import { FACTORY_CARD_QUEUE_REFRESH_MS, factoryCardReadsQueue } from "./factory-section";
import { factoryStageCounts, factoryOverviewPathTarget } from "./factory-card-model";
import {
  aggregateFactories,
  isListedFactory,
  type FactorySummaryInput,
} from "./factory-global-model";
import { ProjectFactoryStateSchema, type ProjectFactoryState } from "./factory-state";

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
  const { factories } = useAllFactories(false);
  const aggregate = useMemo(() => aggregateFactories(factories), [factories]);
  const counts = useMemo(() => factoryStageCounts(aggregate.issues), [aggregate.issues]);
  const firstServerId = factories[0]?.serverId ?? null;
  const routeTarget = factoryOverviewPathTarget(usePathname());
  const openOverview = useCallback(() => {
    if (!firstServerId) return;
    onBeforeNavigate?.();
    router.navigate(allFactoriesOverviewRoute(firstServerId) as Href);
  }, [firstServerId, onBeforeNavigate]);
  if (!mainSidebar || focused || factories.length === 0) return null;
  const anyQueue = factories.some((factory) => factory.issues !== null);
  const queued = counts.find((entry) => entry.segment === "queued")?.count ?? 0;
  const review = counts.find((entry) => entry.segment === "review")?.count ?? 0;
  const active = counts
    .filter((entry) => entry.segment !== "queued" && entry.segment !== "review")
    .reduce((sum, entry) => sum + entry.count, 0);
  const selected = routeTarget !== null && routeTarget.projectId === null;
  return (
    <PressHighlight
      onPress={openOverview}
      accessibilityRole="link"
      accessibilityLabel={t("sidebar.factoryCard.allTitle")}
      accessibilityState={selected ? SELECTED_STATE : undefined}
      style={[styles.summary, selected && styles.selected]}
      testID="factory-global-summary"
    >
      <View style={styles.heading}>
        <SidebarFactoryIcon calm cssHover />
        <Text style={styles.title} numberOfLines={1}>
          {t("sidebar.factoryCard.allTitle")}
        </Text>
        <ThemedArrowRight size={16} uniProps={mutedColor} />
      </View>
      <View style={styles.details}>
        <Text style={styles.counts} numberOfLines={1}>
          {anyQueue
            ? t("projectFactory.scope.pipelineSummary", { queued, active, review })
            : t("projectFactory.loading")}
        </Text>
        <FactoryStageBar issues={aggregate.issues} onPress={openOverview} fullWidth />
      </View>
    </PressHighlight>
  );
});

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedArrowRight = withUnistyles(ArrowRight);
const styles = StyleSheet.create((theme) => ({
  summary: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
    minHeight: 72,
  },
  selected: { backgroundColor: theme.colors.interactionHighlight },
  heading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  details: { marginLeft: 28, gap: theme.spacing[1] },
  counts: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
