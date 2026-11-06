import { projectNameForWorkspace } from "@/hooks/sidebar-workspaces-view-model";
import { useIsFocused } from "expo-router/react-navigation";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PageLayout } from "@/components/page-layout";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ExternalLink } from "@/components/ui/external-link";
import {
  useProjectFactory,
  openFactoryInstructions,
} from "@/components/sidebar/factory-instructions";
import { FactoryModelControls } from "@/components/sidebar/factory-model-controls";
import { FactoryStatusLine } from "@/components/sidebar/factory-status";
import {
  ProjectFactoryStateSchema,
  type ProjectFactoryState,
} from "@/components/sidebar/factory-state";
import { useInstalledPlugins, usePluginCatalogStatus } from "@/plugins/registry";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  loadFactoryQueue,
  factoryAgentStatusKey,
  type FactoryInvoke,
  type FactoryQueue,
} from "./queue";

interface Target {
  serverId: string;
  projectId: string;
}

export function FactoryOverview({ serverId, projectId }: Target) {
  const { t } = useTranslation();
  const focused = useIsFocused();
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
  return (
    <PageLayout
      title={
        name ? t("projectFactory.projectHeading", { project: name }) : t("projectFactory.overview")
      }
      testID="factory-overview"
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

function OverviewContent({
  serverId,
  projectId,
  state,
  invoke,
  active,
}: Target & { state: ProjectFactoryState; invoke: FactoryInvoke; active: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ method, input }: { method: string; input?: { planning: boolean } }) =>
      ProjectFactoryStateSchema.parse(
        await invoke(`factory.project.${method}`, { projectId, ...input }),
      ),
    onSuccess: (next) => client.setQueryData(["projectFactory", serverId, projectId], next),
  });
  const pause = useCallback(() => mutation.mutate({ method: "pause" }), [mutation]);
  const resume = useCallback(() => mutation.mutate({ method: "resume" }), [mutation]);
  const planning = useCallback(
    (value: boolean) => mutation.mutate({ method: "configure", input: { planning: value } }),
    [mutation],
  );
  const queue = useFetchQuery({
    dataShape: "value",
    queryKey: ["factoryQueue", serverId, projectId],
    staleTimeMs: 30_000,
    enabled: active,
    refetchInterval: (query) => (active && query.state.data !== null ? 30_000 : false),
    queryFn: () => loadFactoryQueue(invoke, projectId),
  });
  const reloadQueue = useCallback(() => {
    void queue.refetch();
  }, [queue]);
  const drain = state.drain;
  const showQueue = queue.data != null || queue.isError;
  const status = drain
    ? t("projectFactory.draining", { reason: drain.reason })
    : t(`projectFactory.states.${state.state}`);
  return (
    <>
      <View style={styles.actions}>
        <Text style={styles.text}>{status}</Text>
        {state.state === "on" ? (
          <Button onPress={pause} disabled={mutation.isPending}>
            {t("projectFactory.pauseMenu")}
          </Button>
        ) : null}
        {state.state === "paused" ? (
          <Button onPress={resume} disabled={mutation.isPending}>
            {t("projectFactory.resumeMenu")}
          </Button>
        ) : null}
      </View>
      {drain ? (
        <Text style={styles.text}>
          {t("projectFactory.pausedAt", { time: new Date(drain.pausedAt).toLocaleString() })}
        </Text>
      ) : null}
      {state.reason ? <Text style={styles.text}>{state.reason}</Text> : null}
      {mutation.isPending ? <Text style={styles.text}>{t("projectFactory.saving")}</Text> : null}
      {mutation.error ? (
        <Text style={styles.text} accessibilityRole="alert">
          {mutation.error.message}
        </Text>
      ) : null}
      <SettingsSection title={t("projectFactory.issueStages")}>
        <Text style={styles.text}>{t("projectFactory.nextIssue")}</Text>
        {state.workers.planning !== undefined ? (
          <View style={styles.actions}>
            <Text style={styles.text}>{t("projectFactory.planning")}</Text>
            <Switch
              value={state.workers.planning}
              onValueChange={planning}
              disabled={mutation.isPending}
              accessibilityLabel={t("projectFactory.planning")}
            />
          </View>
        ) : null}
        <FactoryModelControls serverId={serverId} projectId={projectId} stages />
      </SettingsSection>
      {showQueue ? (
        <SettingsSection title={t("projectFactory.workInProgress")}>
          {queue.error ? (
            <Text style={styles.text} accessibilityRole="alert">
              {queue.error.message}
            </Text>
          ) : null}
          {queue.error || queue.data?.error ? (
            <Button onPress={reloadQueue} disabled={queue.isFetching}>
              {t("common.actions.retry")}
            </Button>
          ) : null}
          {queue.isLoading ? <Text style={styles.text}>{t("common.loading")}</Text> : null}
          {queue.data ? <QueueContent serverId={serverId} queue={queue.data} /> : null}
        </SettingsSection>
      ) : null}
      <SettingsSection title={t("projectFactory.roles")}>
        {state.roles.map((role) => (
          <Role key={role.role} serverId={serverId} projectId={projectId} role={role} />
        ))}
      </SettingsSection>
    </>
  );
}

function QueueContent({ serverId, queue }: { serverId: string; queue: FactoryQueue }) {
  const { t } = useTranslation();
  return (
    <>
      {queue.error ? (
        <Text style={styles.text} accessibilityRole="alert">
          {queue.error}
        </Text>
      ) : null}
      {queue.issues.length === 0 && !queue.error ? (
        <Text style={styles.text}>{t("projectFactory.idle")}</Text>
      ) : null}
      {queue.issues.map((issue) => (
        <View key={issue.number} style={styles.item}>
          <ExternalLink href={issue.url} label={`#${issue.number} ${issue.title}`} />
          <Text style={styles.text}>{t(`projectFactory.stages.${issue.stage}`)}</Text>
          {issue.pr ? (
            <View style={styles.actions}>
              <ExternalLink
                href={issue.pr.url}
                label={t("projectFactory.pullRequest", { number: issue.pr.number })}
              />
              {issue.pr.checks ? (
                <Text style={styles.text}>{t(`projectFactory.checks.${issue.pr.checks}`)}</Text>
              ) : null}
            </View>
          ) : null}
          <View style={styles.actions}>
            {issue.agents.map((agent) => (
              <AgentButton
                key={agent.agentId}
                serverId={serverId}
                agentId={agent.agentId}
                label={`${t(`projectFactory.agents.${agent.role}`)}: ${t(factoryAgentStatusKey(agent.status))}`}
              />
            ))}
          </View>
        </View>
      ))}
    </>
  );
}

function AgentButton({
  serverId,
  agentId,
  label,
}: {
  serverId: string;
  agentId: string;
  label: string;
}) {
  const open = useCallback(() => {
    navigateToAgent({ serverId, agentId });
  }, [serverId, agentId]);
  return <Button onPress={open}>{label}</Button>;
}

function Role({
  serverId,
  projectId,
  role,
}: Target & { role: ProjectFactoryState["roles"][number] }) {
  const { t } = useTranslation();
  const instructions = useCallback(
    () => openFactoryInstructions({ serverId, projectId, role: role.role }),
    [serverId, projectId, role.role],
  );
  return (
    <SettingsSection title={role.title}>
      <FactoryStatusLine status={role.status} />
      <View style={styles.actions}>
        {role.agentId ? (
          <AgentButton
            serverId={serverId}
            agentId={role.agentId}
            label={t("projectFactory.openThread")}
          />
        ) : null}
        <Button onPress={instructions}>{t("projectFactory.instructions")}</Button>
      </View>
      <FactoryModelControls serverId={serverId} projectId={projectId} role={role.role} />
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[3],
  },
  item: { gap: theme.spacing[2], paddingVertical: theme.spacing[3] },
}));
