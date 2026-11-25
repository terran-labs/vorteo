import { router } from "expo-router";
import { Settings } from "lucide-react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipText, TooltipTrigger } from "@/components/ui/tooltip";
import { useProjectFactory } from "@/components/sidebar/factory-instructions";
import {
  ProjectFactoryStateSchema,
  type ProjectFactoryState,
} from "@/components/sidebar/factory-state";
import { PLUGIN_SURFACE_MESSAGES } from "@/plugins/surface-contribution";
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
import { FactoryScopeSelector, type FactoryScope } from "./scope-selector";
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
  sampleFactory,
  sampleQuotaAccounts,
} from "./overview-sample";
import { useAllFactories, useFactoryHosts, useProjectNames, useStopAll } from "./overview-sources";
import { factoryListQueryKey } from "./factory-reads";
import { projectFactoryOverviewRoute, projectFactorySettingsRoute } from "./routes";
import { useFactoryPlugin, type FactoryAvailability } from "./availability";
import {
  factoryQueueRefreshInterval,
  loadFactoryQueue,
  type FactoryInvoke,
  type FactoryQueue,
} from "./queue";

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

const ALL_SCOPE: FactoryScope = { kind: "all" };
const SAMPLE_SCOPE: FactoryScope = { kind: "sample" };

/** Why a Factory page has nothing to show yet, in the words other plugin pages use. */
function FactoryPlaceholder({ availability }: { availability: FactoryAvailability }) {
  const { t } = useTranslation();
  if (availability === "ready" || availability === "loading") return null;
  return (
    <Text style={styles.text}>
      {availability === "offline"
        ? PLUGIN_SURFACE_MESSAGES.offline
        : t("projectFactory.states.unavailable")}
    </Text>
  );
}

function AllOverview({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  useDirectoryDemand(focused ? serverId : null);
  const { availability } = useFactoryPlugin(serverId);
  const hosts = useFactoryHosts();
  const titleContent = useMemo(
    () => <FactoryScopeSelector serverId={serverId} scope={ALL_SCOPE} />,
    [serverId],
  );
  return (
    <PageLayout
      title={t("projectFactory.scope.allTitle")}
      testID="factory-overview"
      wide
      headerTitle
      fullWidth
      titleContent={titleContent}
    >
      {hosts.length === 0 ? <FactoryPlaceholder availability={availability} /> : null}
      {focused ? <AllContent serverId={serverId} active={focused} /> : null}
    </PageLayout>
  );
}

function ProjectOverview({ serverId, projectId }: Target) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  useDirectoryDemand(focused ? serverId : null);
  const factory = useProjectFactory(serverId, projectId, focused);
  const reload = useCallback(() => {
    void factory.refetch();
  }, [factory]);
  const { plugin, availability } = useFactoryPlugin(serverId);
  const scope = useMemo(() => ({ kind: "project" as const, projectId }), [projectId]);
  const name = useProjectNames()(serverId, projectId);
  const loading = !factory.data && !factory.error;
  const showsUnavailable = availability === "unavailable" || availability === "offline";
  const live = factory.data && factory.data.state !== "off" && plugin;
  const actions = useMemo(
    () => (live ? <FactorySettingsButton serverId={serverId} projectId={projectId} /> : undefined),
    [live, serverId, projectId],
  );
  const titleContent = useMemo(
    () => <FactoryScopeSelector serverId={serverId} scope={scope} />,
    [serverId, scope],
  );
  return (
    <PageLayout
      title={
        name ? t("projectFactory.projectHeading", { project: name }) : t("projectFactory.overview")
      }
      testID="factory-overview"
      actions={actions}
      wide
      headerTitle
      fullWidth
      titleContent={titleContent}
    >
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
      {loading && !showsUnavailable ? (
        <Text style={styles.text}>{t("projectFactory.loading")}</Text>
      ) : null}
      <FactoryPlaceholder availability={availability} />
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

/** Opens one live Factory's settings. All Factories and the Sample Factory have none. */
function FactorySettingsButton({ serverId, projectId }: Target) {
  const { t } = useTranslation();
  const open = useCallback(
    () => router.navigate(projectFactorySettingsRoute(serverId, projectId)),
    [serverId, projectId],
  );
  const label = t("projectFactory.settings.open");
  return (
    <Tooltip enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Settings}
          onPress={open}
          accessibilityLabel={label}
          testID="factory-settings-open"
        />
      </TooltipTrigger>
      <TooltipContent>
        <TooltipText label={label} />
      </TooltipContent>
    </Tooltip>
  );
}

/** Sample data to preview the overview. Nothing on it reaches a real Factory. */
export function SampleFactoryOverview({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const titleContent = useMemo(
    () => <FactoryScopeSelector serverId={serverId} scope={SAMPLE_SCOPE} />,
    [serverId],
  );
  return (
    <PageLayout
      title={t("projectFactory.scope.sample")}
      testID="factory-overview"
      wide
      headerTitle
      fullWidth
      titleContent={titleContent}
    >
      {focused ? <SampleContent serverId={serverId} active={focused} /> : null}
    </PageLayout>
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
 * The Sample Factory passes its sample entry and marks the data as sample.
 */
function useOverviewData(input: {
  scope: "project" | "all";
  sample?: boolean;
  serverId: string;
  focus: FactoryOverviewData["focus"];
  entries: FactoryScopeEntry[];
  queue: LiveQueue;
  active: boolean;
}): FactoryOverviewData {
  const { scope, serverId, focus, entries, queue, active, sample = false } = input;
  const sessions = useSessionStore((store) => store.sessions);
  const usage = useProviderUsage(serverId, { pollUsage: true, enabled: active });
  const factoryHosts = useFactoryHosts();
  // Global stop and resume act on whole hosts, so only All Factories, which sees every project
  // on each host, offers them.
  const stopHosts = useMemo(() => (scope === "all" ? factoryHosts : []), [scope, factoryHosts]);
  const stopAll = useStopAll(stopHosts, entries);
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
    entries,
    sessions,
    usage.view,
    queue,
    focus,
    stopAll,
    zoomIn,
    openAgent,
  ]);
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
    refetchInterval: (query) =>
      factoryQueueRefreshInterval({
        queue: query.state.data,
        enabled: active,
        polling: true,
        steadyMs: 30_000,
      }),
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

// Every Sample Factory control is off, so nothing on it reaches a real Factory.
const SAMPLE_CONTROLS: FactoryControls = {
  pause: () => undefined,
  resume: () => undefined,
  setPlanning: () => undefined,
  pending: false,
  disabled: true,
  error: null,
};

function SampleContent({ serverId, active }: { serverId: string; active: boolean }) {
  const [openedAt] = useState(() => Date.now());
  const sample = useMemo(() => sampleFactory(serverId, openedAt), [serverId, openedAt]);
  const focus = useMemo(
    () => ({ projectId: sample.entry.projectId, state: sample.state, controls: SAMPLE_CONTROLS }),
    [sample],
  );
  const entries = useMemo(() => [sample.entry], [sample]);
  const queue = useMemo<LiveQueue>(
    () => ({
      data: null,
      loading: false,
      fetching: false,
      error: null,
      reload: () => undefined,
      updatedAt: openedAt,
    }),
    [openedAt],
  );
  const data = useOverviewData({
    scope: "project",
    sample: true,
    serverId,
    focus,
    entries,
    queue,
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
          {t("projectFactory.design.sampleNotice")}
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
  content: { gap: theme.spacing[3] },
}));
