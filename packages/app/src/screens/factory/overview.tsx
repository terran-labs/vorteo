import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useProjectFactory } from "@/components/sidebar/factory-instructions";
import {
  ProjectFactoryStateSchema,
  type ProjectFactoryState,
} from "@/components/sidebar/factory-state";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useInstalledPlugins, usePluginCatalogStatus } from "@/plugins/registry";
import { useFetchQuery } from "@/data/query";
import { quotaAccounts } from "@/provider-usage/global-quota";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  activeDrains,
  factoryScopeKey,
  scopedIssues,
  type FactoryScopeEntry,
} from "./all-factories-model";
import { FactoryScopeSelector } from "./scope-selector";
import type { FactoryControls } from "./overview-controls";
import type { FactoryOverviewData } from "./overview-data";
import { FloorOverview } from "./overview-floor";
import {
  addUsage,
  factoryLanes,
  factoryQueueFigures,
  factoryUsage,
  type FactoryAgentLookup,
  type FactoryCategory,
  type FactoryUsageSummary,
} from "./overview-model";
import {
  SAMPLE_ACCOUNT_SPEND,
  SAMPLE_HISTORY,
  SAMPLE_ROLE_USAGE,
  sampleAgentLookup,
  sampleFactoryEntries,
  sampleQuotaAccounts,
} from "./overview-sample";
import { useAllFactories, useFactoryHosts, useProjectNames, useStopAll } from "./overview-sources";
import { factoryListQueryKey } from "./factory-reads";
import { projectFactoryOverviewRoute } from "./routes";
import { useFactoryOverviewStore } from "./overview-store";
import { loadFactoryQueue, type FactoryInvoke, type FactoryQueue } from "./queue";

interface Target {
  serverId: string;
  projectId: string;
}

/** One project's Factory, or every Factory in the installation when projectId is null. */
export function FactoryOverview({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string | null;
}) {
  return projectId ? (
    <ProjectOverview serverId={serverId} projectId={projectId} />
  ) : (
    <AllOverview serverId={serverId} />
  );
}

function AllOverview({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const compact = useIsCompactFormFactor();
  useDirectoryDemand(focused ? serverId : null);
  const catalogStatus = usePluginCatalogStatus(serverId);
  const hosts = useFactoryHosts();
  const bar = useMemo(() => <DesignBar />, []);
  const titleContent = useMemo(
    () => <FactoryScopeSelector serverId={serverId} projectId={null} />,
    [serverId],
  );
  return (
    <PageLayout
      title={t("projectFactory.scope.allTitle")}
      testID="factory-overview"
      actions={compact ? undefined : bar}
      wide
      headerTitle
      fullWidth
      titleContent={titleContent}
    >
      {compact ? bar : null}
      {hosts.length === 0 && catalogStatus !== "loading" ? (
        <Text style={styles.text}>{t("projectFactory.states.unavailable")}</Text>
      ) : null}
      {focused ? <AllContent serverId={serverId} active={focused} /> : null}
    </PageLayout>
  );
}

function ProjectOverview({ serverId, projectId }: Target) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const compact = useIsCompactFormFactor();
  useDirectoryDemand(focused ? serverId : null);
  const catalogStatus = usePluginCatalogStatus(serverId);
  const factory = useProjectFactory(serverId, projectId, focused);
  const reload = useCallback(() => {
    void factory.refetch();
  }, [factory]);
  const plugin = useInstalledPlugins().find(
    (entry) => entry.id === "factory" && entry.serverId === serverId,
  );
  const name = useProjectNames()(serverId, projectId);
  const unavailable = !plugin && catalogStatus !== "loading";
  const loading = !factory.data && !factory.error && !unavailable;
  const bar = useMemo(() => <DesignBar />, []);
  const titleContent = useMemo(
    () => <FactoryScopeSelector serverId={serverId} projectId={projectId} />,
    [serverId, projectId],
  );
  return (
    <PageLayout
      title={
        name ? t("projectFactory.projectHeading", { project: name }) : t("projectFactory.overview")
      }
      testID="factory-overview"
      actions={compact ? undefined : bar}
      wide
      headerTitle
      fullWidth
      titleContent={titleContent}
    >
      {compact ? bar : null}
      {factory.error ? (
        <View>
          <Text style={styles.text} accessibilityRole="alert">
            {factory.error.message}
          </Text>
          <Button onPress={reload} disabled={factory.isFetching}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}
      {loading ? <Text style={styles.text}>{t("projectFactory.loading")}</Text> : null}
      {unavailable ? (
        <Text style={styles.text}>{t("projectFactory.states.unavailable")}</Text>
      ) : null}
      {factory.data?.state === "off" ? (
        <View testID="factory-overview-off">
          <Text style={styles.text}>{t("projectFactory.states.off")}</Text>
          <Text style={styles.text}>{t("projectFactory.turnOnHint")}</Text>
        </View>
      ) : null}
      {factory.data && factory.data.state !== "off" && plugin && focused ? (
        <ProjectContent
          serverId={serverId}
          projectId={projectId}
          name={name}
          state={factory.data}
          invoke={plugin.invoke}
          active={focused}
        />
      ) : null}
    </PageLayout>
  );
}

/** Keep the explicit sample-data switch separate from Factory scope. */
function DesignBar() {
  const { t } = useTranslation();
  const sample = useFactoryOverviewStore((store) => store.sample);
  const setSample = useFactoryOverviewStore((store) => store.setSample);
  const sources = useMemo<SegmentedControlOption<"live" | "sample">[]>(
    () => [
      { value: "live", label: t("projectFactory.design.live"), testID: "factory-data-live" },
      { value: "sample", label: t("projectFactory.design.sample"), testID: "factory-data-sample" },
    ],
    [t],
  );
  const setSource = useCallback(
    (value: "live" | "sample") => setSample(value === "sample"),
    [setSample],
  );
  return (
    <View style={styles.bar} testID="factory-design-bar">
      <SegmentedControl
        options={sources}
        value={sample ? "sample" : "live"}
        onValueChange={setSource}
        size="sm"
      />
    </View>
  );
}

interface LiveQueue {
  data: FactoryQueue | null;
  loading: boolean;
  fetching: boolean;
  error: Error | null;
  reload: () => void;
  updatedAt: number;
}

/**
 * Assembles the board, reports and operating controls for the selected Factory scope.
 * Sample mode swaps in the sample Factories.
 */
function useOverviewData(input: {
  scope: "project" | "all";
  serverId: string;
  focus: FactoryOverviewData["focus"];
  entries: FactoryScopeEntry[];
  queue: LiveQueue;
  active: boolean;
}): FactoryOverviewData {
  const { scope, serverId, focus, entries: liveEntries, queue, active } = input;
  const sample = useFactoryOverviewStore((store) => store.sample);
  const sessions = useSessionStore((store) => store.sessions);
  const usage = useProviderUsage(serverId, { pollUsage: true, enabled: active });
  const factoryHosts = useFactoryHosts();
  // Global stop and resume act on whole hosts, so only All Factories, which sees every project
  // on each host, offers them.
  const stopHosts = useMemo(() => (scope === "all" ? factoryHosts : []), [scope, factoryHosts]);
  const stopAll = useStopAll(stopHosts, liveEntries);
  const openAgent = useCallback(
    (agentId: string, host?: string) => navigateToAgent({ serverId: host ?? serverId, agentId }),
    [serverId],
  );
  const zoomIn = useCallback(
    (host: string, projectId: string) =>
      router.navigate(projectFactoryOverviewRoute(host, projectId)),
    [],
  );
  // The clock advances when fresh queues land, so ages and day labels hold between polls.
  const [openedAt] = useState(() => Date.now());
  const now = queue.updatedAt || openedAt;
  return useMemo<FactoryOverviewData>(() => {
    const entries = sample ? sampleScope(scope, serverId, now) : liveEntries;
    const issues = scope === "all" ? scopedIssues(entries) : (entries[0]?.issues ?? []);
    const lookup: FactoryAgentLookup = sample
      ? sampleAgentLookup(now)
      : (agentId, host) => {
          const agent = sessions[host]?.agents.get(agentId);
          return agent
            ? { provider: agent.provider, usage: agent.lastUsage, createdAt: agent.createdAt }
            : undefined;
        };
    const roles = sample
      ? []
      : entries.flatMap((entry) =>
          (entry.state?.roles ?? []).map((role) => ({
            serverId: entry.serverId,
            role: role.role,
            agentId: role.agentId,
          })),
        );
    const summary = factoryUsage(issues, roles, lookup, serverId);
    const live = quotaAccounts(usage.view, now);
    const sampleQuota = sample && live.length === 0;
    const shownQueue: FactoryQueue | null = sample
      ? { fetchedAt: new Date(now - 90_000).toISOString(), error: null, issues }
      : queue.data && { ...queue.data, issues };
    return {
      scope,
      serverId,
      focus,
      factories: entries,
      drains: activeDrains(entries),
      stopAll,
      zoomIn,
      sample,
      queue: {
        data: shownQueue,
        loading: !sample && queue.loading,
        fetching: queue.fetching,
        error: sample ? null : queue.error,
        reload: queue.reload,
      },
      lanes: factoryLanes(issues),
      figures: factoryQueueFigures(issues),
      usage: sample ? withSampleRoles(summary) : summary,
      quota: {
        accounts: sampleQuota ? sampleQuotaAccounts(now) : live,
        sample: sampleQuota,
        spend: sampleQuota ? SAMPLE_ACCOUNT_SPEND : {},
      },
      history: SAMPLE_HISTORY,
      openAgent: sample ? undefined : openAgent,
      now,
    };
  }, [
    sample,
    scope,
    serverId,
    now,
    liveEntries,
    sessions,
    usage.view,
    queue,
    focus,
    stopAll,
    zoomIn,
    openAgent,
  ]);
}

function sampleScope(scope: "project" | "all", serverId: string, now: number) {
  const entries = sampleFactoryEntries(serverId, now);
  return scope === "all" ? entries : entries.slice(0, 1);
}

function ProjectContent({
  serverId,
  projectId,
  name,
  state,
  invoke,
  active,
}: Target & {
  name: string | undefined;
  state: ProjectFactoryState;
  invoke: FactoryInvoke;
  active: boolean;
}) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ method, input }: { method: string; input?: { planning: boolean } }) =>
      ProjectFactoryStateSchema.parse(
        await invoke(`factory.project.${method}`, { projectId, ...input }),
      ),
    onSuccess: (next) => {
      client.setQueryData(["projectFactory", serverId, projectId], next);
      // The list carries pause and drain state for the sidebar and All Factories.
      void client.invalidateQueries({ queryKey: factoryListQueryKey(serverId) });
    },
  });
  const { mutate } = mutation;
  const pause = useCallback(() => mutate({ method: "pause" }), [mutate]);
  const resume = useCallback(() => mutate({ method: "resume" }), [mutate]);
  const setPlanning = useCallback(
    (value: boolean) => mutate({ method: "configure", input: { planning: value } }),
    [mutate],
  );
  const queue = useFetchQuery({
    dataShape: "value",
    queryKey: ["factoryQueue", serverId, projectId],
    staleTimeMs: 30_000,
    enabled: active,
    refetchInterval: (query) => (active && query.state.data !== null ? 30_000 : false),
    queryFn: () => loadFactoryQueue(invoke, projectId),
  });
  const { refetch } = queue;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  const controls = useMemo<FactoryControls>(
    () => ({
      pause,
      resume,
      setPlanning,
      pending: mutation.isPending,
      error: mutation.error,
    }),
    [pause, resume, setPlanning, mutation.isPending, mutation.error],
  );
  const focus = useMemo(() => ({ projectId, state, controls }), [projectId, state, controls]);
  const entries = useMemo<FactoryScopeEntry[]>(
    () => [
      {
        key: factoryScopeKey(serverId, projectId),
        serverId,
        projectId,
        name: name ?? projectId,
        hostLabel: null,
        state,
        status: state.state,
        drain: state.drain ?? null,
        issues: queue.data?.issues ?? null,
      },
    ],
    [serverId, projectId, name, state, queue.data],
  );
  const liveQueue = useMemo<LiveQueue>(
    () => ({
      data: queue.data ?? null,
      loading: queue.isLoading,
      fetching: queue.isFetching,
      error: queue.error,
      reload,
      updatedAt: queue.dataUpdatedAt,
    }),
    [queue.data, queue.isLoading, queue.isFetching, queue.error, reload, queue.dataUpdatedAt],
  );
  const data = useOverviewData({
    scope: "project",
    serverId,
    focus,
    entries,
    queue: liveQueue,
    active,
  });
  return <DesignFrame data={data} />;
}

/** Every Factory on every Factory host of the installation. */
function AllContent({ serverId, active }: { serverId: string; active: boolean }) {
  const client = useQueryClient();
  const all = useAllFactories(active);
  const reload = useCallback(() => {
    void client.invalidateQueries({ queryKey: ["factoryProjectList"] });
    void client.invalidateQueries({ queryKey: ["factoryQueue"] });
  }, [client]);
  const liveQueue = useMemo<LiveQueue>(
    () => ({
      data: all.hosts.length
        ? {
            fetchedAt: new Date(all.updatedAt || Date.now()).toISOString(),
            error: null,
            issues: [],
          }
        : null,
      loading: all.loading,
      fetching: false,
      error: null,
      reload,
      updatedAt: all.updatedAt,
    }),
    [all.hosts.length, all.updatedAt, all.loading, reload],
  );
  const data = useOverviewData({
    scope: "all",
    serverId,
    focus: null,
    entries: all.entries,
    queue: liveQueue,
    active,
  });
  return <DesignFrame data={data} />;
}

function DesignFrame({ data }: { data: FactoryOverviewData }) {
  const { t } = useTranslation();
  return (
    <View style={styles.content}>
      {data.sample ? (
        <Text style={styles.notice} testID="factory-sample-notice">
          {t(
            data.scope === "all"
              ? "projectFactory.design.sampleNoticeAll"
              : "projectFactory.design.sampleNotice",
          )}
        </Text>
      ) : null}
      <FloorOverview data={data} />
    </View>
  );
}

/** Sample role threads have no ids, so their share joins the category and provider totals. */
function withSampleRoles(summary: FactoryUsageSummary): FactoryUsageSummary {
  const byCategory = { ...summary.byCategory };
  let total = summary.total;
  for (const [category, entry] of Object.entries(SAMPLE_ROLE_USAGE)) {
    if (!entry) continue;
    const usage = { inputTokens: entry.tokens, estimatedCostUsd: entry.usd };
    byCategory[category as FactoryCategory] = addUsage(
      byCategory[category as FactoryCategory],
      usage,
    );
    total = addUsage(total, usage);
  }
  return { ...summary, byCategory, total };
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  notice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  content: { gap: theme.spacing[3] },
}));
