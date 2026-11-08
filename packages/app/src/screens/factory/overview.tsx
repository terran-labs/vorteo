import { projectNameForWorkspace } from "@/hooks/sidebar-workspaces-view-model";
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
import type { FactoryControls } from "./overview-controls";
import type { FactoryOverviewData } from "./overview-data";
import { FloorOverview } from "./overview-floor";
import { LedgerOverview } from "./overview-ledger";
import { MissionOverview } from "./overview-mission";
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
  sampleFactoryQueue,
  sampleQuotaAccounts,
} from "./overview-sample";
import { useFactoryOverviewStore, type FactoryOverviewVariant } from "./overview-store";
import { loadFactoryQueue, type FactoryInvoke } from "./queue";

interface Target {
  serverId: string;
  projectId: string;
}

export function FactoryOverview({ serverId, projectId }: Target) {
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
  const name = useSessionStore((store) => {
    const session = store.sessions[serverId];
    const workspace = Array.from(session?.workspaces.values() ?? []).find(
      (entry) => entry.projectId === projectId,
    );
    const project = session?.projects.get(projectId);
    return workspace
      ? projectNameForWorkspace(workspace)
      : (project?.projectCustomName ?? project?.projectDisplayName);
  });
  const unavailable = !plugin && catalogStatus !== "loading";
  const loading = !factory.data && !factory.error && !unavailable;
  const bar = useMemo(() => <DesignBar />, []);
  return (
    <PageLayout
      title={
        name ? t("projectFactory.projectHeading", { project: name }) : t("projectFactory.overview")
      }
      testID="factory-overview"
      actions={compact ? undefined : bar}
      wide
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
        <OverviewContent
          serverId={serverId}
          projectId={projectId}
          state={factory.data}
          invoke={plugin.invoke}
          active={focused}
        />
      ) : null}
    </PageLayout>
  );
}

/** Design and data toggles the owner uses to compare the three overview designs. */
function DesignBar() {
  const { t } = useTranslation();
  const variant = useFactoryOverviewStore((store) => store.variant);
  const sample = useFactoryOverviewStore((store) => store.sample);
  const setVariant = useFactoryOverviewStore((store) => store.setVariant);
  const setSample = useFactoryOverviewStore((store) => store.setSample);
  const variants = useMemo<SegmentedControlOption<FactoryOverviewVariant>[]>(
    () => [
      { value: "floor", label: t("projectFactory.design.floor"), testID: "factory-design-floor" },
      {
        value: "mission",
        label: t("projectFactory.design.mission"),
        testID: "factory-design-mission",
      },
      {
        value: "ledger",
        label: t("projectFactory.design.ledger"),
        testID: "factory-design-ledger",
      },
    ],
    [t],
  );
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
      <SegmentedControl options={variants} value={variant} onValueChange={setVariant} size="sm" />
      <SegmentedControl
        options={sources}
        value={sample ? "sample" : "live"}
        onValueChange={setSource}
        size="sm"
      />
    </View>
  );
}

function OverviewContent({
  serverId,
  projectId,
  state,
  invoke,
  active,
}: Target & { state: ProjectFactoryState; invoke: FactoryInvoke; active: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const variant = useFactoryOverviewStore((store) => store.variant);
  const sample = useFactoryOverviewStore((store) => store.sample);
  const mutation = useMutation({
    mutationFn: async ({ method, input }: { method: string; input?: { planning: boolean } }) =>
      ProjectFactoryStateSchema.parse(
        await invoke(`factory.project.${method}`, { projectId, ...input }),
      ),
    onSuccess: (next) => client.setQueryData(["projectFactory", serverId, projectId], next),
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
  const reloadQueue = useCallback(() => {
    void refetch();
  }, [refetch]);
  const agents = useSessionStore((store) => store.sessions[serverId]?.agents);
  const usage = useProviderUsage(serverId, { pollUsage: true, enabled: active });
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
  const openAgent = useCallback(
    (agentId: string) => navigateToAgent({ serverId, agentId }),
    [serverId],
  );
  const queueData = queue.data;
  const queueUpdatedAt = queue.dataUpdatedAt;
  // The clock advances when a fresh queue lands, so ages and day labels stay stable between polls.
  const [openedAt] = useState(() => Date.now());
  const now = queueUpdatedAt || openedAt;
  const data = useMemo<FactoryOverviewData>(() => {
    const shown = sample ? sampleFactoryQueue(now) : (queueData ?? null);
    const issues = shown?.issues ?? [];
    const lookup: FactoryAgentLookup = sample
      ? sampleAgentLookup(now)
      : (agentId) => {
          const agent = agents?.get(agentId);
          return agent
            ? { provider: agent.provider, usage: agent.lastUsage, createdAt: agent.createdAt }
            : undefined;
        };
    const summary = factoryUsage(issues, sample ? [] : state.roles, lookup);
    const live = quotaAccounts(usage.view, now);
    const sampleQuota = sample && live.length === 0;
    return {
      serverId,
      projectId,
      state,
      controls,
      sample,
      queue: {
        data: shown,
        loading: !sample && queue.isLoading,
        fetching: queue.isFetching,
        error: sample ? null : queue.error,
        reload: reloadQueue,
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
    now,
    sample,
    queueData,
    agents,
    state,
    usage.view,
    serverId,
    projectId,
    controls,
    queue.isLoading,
    queue.isFetching,
    queue.error,
    reloadQueue,
    openAgent,
  ]);
  return (
    <View style={styles.content}>
      {sample ? (
        <Text style={styles.notice} testID="factory-sample-notice">
          {t("projectFactory.design.sampleNotice")}
        </Text>
      ) : null}
      <Design variant={variant} data={data} />
    </View>
  );
}

function Design({ variant, data }: { variant: FactoryOverviewVariant; data: FactoryOverviewData }) {
  switch (variant) {
    case "floor":
      return <FloorOverview data={data} />;
    case "mission":
      return <MissionOverview data={data} />;
    case "ledger":
      return <LedgerOverview data={data} />;
  }
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
