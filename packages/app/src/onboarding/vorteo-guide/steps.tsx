import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { useMutation } from "@tanstack/react-query";
import { AgentSkillsRow, areSkillsInstalled, useAgentSkills } from "@/agent-skills";
import { SettingsCard } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { useInstallationSettings } from "@/execution-installation/settings";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { advertisedProjectsRoot } from "@/projects/projects-root";
import { ProjectSuggestionList, type ProjectSuggestionsController } from "@/project-suggestions";
import { AppearanceSection } from "@/screens/settings/appearance/appearance-section";
import { PaseoToolsRow } from "@/screens/settings/paseo-tools-card";
import { useSessionStore } from "@/stores/session-store";
import { selectIsSystemProject } from "@/workspace/lifecycle/system-membership";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";
import type { OnboardingStepId } from "../internal/model";
import type { VorteoGuideModel } from "./model";
import { EnvironmentAccounts } from "./environment-accounts";
import { DeviceAccess } from "./device-access";

interface GuideStepProps {
  step: OnboardingStepId;
  serverId: string;
  model: VorteoGuideModel;
  suggestions: ProjectSuggestionsController;
}

export function GuideStep({ step, serverId, model, suggestions }: GuideStepProps) {
  if (step === "appearance") return <AppearanceSection />;
  if (step === "providers") return <AccountsStep serverId={serverId} model={model} />;
  if (step === "projects") return <ProjectsStep serverId={serverId} suggestions={suggestions} />;
  if (step === "orchestration") return <ToolsStep serverId={serverId} />;
  return <DeviceAccess model={model} />;
}

function AccountsStep({ serverId, model }: { serverId: string; model: VorteoGuideModel }) {
  const { t } = useTranslation();
  const router = useRouter();
  const installation = readExecutionInstallation();
  const host = installation?.environments.find((environment) => environment.kind === "host");
  const providers = useCallback(() => {
    void model.pause().then(() => router.push(buildSettingsSectionRoute("providers")));
  }, [model, router]);
  const visit = model.getState();
  const visitToken = visit.status === "open" ? visit.visit : null;
  const useConnection = useCallback(
    async (providerId: string) => {
      const current = model.getState();
      if (
        current.status !== "open" ||
        current.serverId !== serverId ||
        current.visit !== visitToken ||
        current.steps[current.stepIndex] !== "providers"
      )
        return;
      const result = await model.recordPrimaryConnection(providerId, current.visit);
      if (result !== "stale") model.next(current.visit);
    },
    [model, serverId, visitToken],
  );
  const skip = useCallback(() => {
    const current = model.getState();
    if (current.status === "open" && current.visit === visitToken) model.next(current.visit);
  }, [model, visitToken]);
  return (
    <View style={styles.content}>
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.accountsHint")}</Text>
      {host ? (
        <EnvironmentAccounts
          serverId={host.serverId}
          initialProviderId={model.primaryRuntimeProviderId}
          onUse={useConnection}
          onSkip={skip}
          onSettings={providers}
        />
      ) : null}
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.moreProviders")}</Text>
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.profilesHint")}</Text>
    </View>
  );
}

function ProjectsStep({
  serverId,
  suggestions,
}: {
  serverId: string;
  suggestions: ProjectSuggestionsController;
}) {
  const { t } = useTranslation();
  const open = useOpenAddProject();
  const root = useSessionStore((state) =>
    advertisedProjectsRoot(state.sessions[serverId]?.serverInfo),
  );
  const count = useSessionStore(
    (state) =>
      Array.from(state.sessions[serverId]?.projects.values() ?? []).filter(
        (project) => !selectIsSystemProject(state, serverId, project.projectId),
      ).length,
  );
  const addProject = useCallback(() => open(serverId), [open, serverId]);
  return (
    <View style={styles.content}>
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.projectHint")}</Text>
      <Text selectable style={settingsStyles.rowTitle}>
        {root ? t("vorteoSetup.projectsFolder", { path: root }) : t("vorteoSetup.projectsUnknown")}
      </Text>
      <Button variant="outline" onPress={addProject}>
        {t("onboarding.setup.steps.projects.addProject")}
      </Button>
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.userProjects", { count })}</Text>
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.systemExcluded")}</Text>
      {suggestions.list.status === "unsupported" ? (
        <Text style={settingsStyles.rowHint}>{t("vorteoSetup.suggestionsUnavailable")}</Text>
      ) : (
        <ProjectSuggestionList serverId={serverId} suggestions={suggestions} />
      )}
    </View>
  );
}

function ToolsStep({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const shared = useInstallationSettings();
  const { data, save } = shared;
  const change = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!data?.settings) throw new Error(t("vorteoSetup.sharedSettingsUnavailable"));
      return save({
        expectedRevision: data.revision,
        settings: { mcp: { ...data.settings.mcp, injectIntoAgents: enabled } },
      });
    },
  });
  const toggle = useCallback((enabled: boolean) => change.mutate(enabled), [change]);
  return (
    <View style={styles.content}>
      <Text style={settingsStyles.rowHint}>{t("vorteoSetup.preferencesHint")}</Text>
      {data?.settings ? (
        <SettingsCard>
          <PaseoToolsRow
            value={data.settings.mcp.injectIntoAgents !== false}
            onValueChange={toggle}
            disabled={change.isPending}
          />
        </SettingsCard>
      ) : (
        <Text style={settingsStyles.rowHint}>{t("vorteoSetup.sharedSettingsUnavailable")}</Text>
      )}
      {change.error ? <Alert variant="error" description={toErrorMessage(change.error)} /> : null}
      <GuideSkills serverId={serverId} />
    </View>
  );
}

function GuideSkills({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const skills = useAgentSkills(serverId);
  const change = useMutation({
    mutationFn: async (enabled: boolean) => {
      return enabled ? skills.reconcile() : skills.uninstall();
    },
  });
  const toggle = useCallback((enabled: boolean) => change.mutate(enabled), [change]);
  return (
    <View style={styles.content}>
      <SettingsCard>
        <AgentSkillsRow
          skills={skills}
          value={areSkillsInstalled(skills.status)}
          onValueChange={toggle}
          disabled={change.isPending || !skills.connected || !skills.supported}
        />
      </SettingsCard>
      {skills.isLoading ? <Text style={settingsStyles.rowHint}>{t("common.loading")}</Text> : null}
      {change.error ? <Alert variant="warning" description={toErrorMessage(change.error)} /> : null}
      {change.data === false ? (
        <Alert variant="info" description={t("vorteoSetup.skillsUnchanged")} />
      ) : null}
      {skills.error ? <Alert variant="error" description={toErrorMessage(skills.error)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({ content: { gap: theme.spacing[4] } }));
