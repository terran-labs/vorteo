import { StyleSheet } from "react-native-unistyles";
import { factoryModelConfiguration } from "./project-factory-model";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useAgentProfiles, type AgentProfilePicker } from "@/agent-profiles";
import { PresetControls } from "@/agent-profiles/preset-controls";
import { Button } from "@/components/ui/button";
import { useInstalledPlugins } from "@/plugins/registry";
import { useProjectFactory } from "./factory-instructions";
import type { RoleId } from "./factory-instructions-model";
import type { ProjectFactoryState } from "./project-factory";
interface Target {
  serverId: string;
  projectId: string;
  role?: RoleId;
}
export function FactoryModelControls(target: Target) {
  const { t } = useTranslation();
  const state = useProjectFactory(target.serverId, target.projectId, true);
  if (!state.data) return null;
  if (target.role)
    return (
      <ModelPicker
        target={target}
        state={state.data}
        field="role"
        label={t("projectFactory.model")}
      />
    );
  return (
    <View>
      <ModelPicker
        target={target}
        state={state.data}
        field="workerProfileId"
        label={t("projectFactory.workerModel")}
      />
      <ModelPicker
        target={target}
        state={state.data}
        field="reviewerProfileId"
        label={t("projectFactory.reviewerModel")}
      />
    </View>
  );
}
function ModelPicker({
  target,
  state,
  field,
  label,
}: {
  target: Target;
  state: ProjectFactoryState;
  field: "role" | "workerProfileId" | "reviewerProfileId";
  label: string;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const plugin = useInstalledPlugins().find(
    (p) => p.id === "factory" && p.serverId === target.serverId,
  );
  const { profiles } = useAgentProfiles(target.serverId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launch = state.roles.find((candidate) => candidate.role === target.role)?.launch;
  const selected = field === "role" ? launch?.profileId : state.workers?.[field];
  const configure = useCallback(
    async (profileId: string | null) => {
      if (!plugin || pending) return;
      setPending(true);
      setError(null);
      try {
        const profile = profiles?.find((candidate) => candidate.id === profileId);
        const next = await plugin.invoke(
          "factory.project.configure",
          factoryModelConfiguration(
            target.projectId,
            field,
            profileId,
            target.role,
            profile?.provider,
          ),
        );
        client.setQueryData(["projectFactory", target.serverId, target.projectId], next);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("projectFactory.failed"));
      } finally {
        setPending(false);
      }
    },
    [plugin, pending, profiles, target, field, client, t],
  );
  const apply = useCallback((id: string) => void configure(id), [configure]);
  const clear = useCallback(() => void configure(null), [configure]);
  const picker = useMemo<AgentProfilePicker>(
    () => ({
      projectPath: null,
      applyProfile: apply,
      isApplying: pending,
      rows: (profiles ?? []).map((profile) => ({
        id: profile.id,
        provider: profile.provider,
        modelId: profile.model ?? "",
        icon: profile.icon ?? "",
        color: profile.color ?? "",
        name: profile.name,
        summary: profile.model ?? profile.provider,
      })),
    }),
    [apply, pending, profiles],
  );
  return (
    <View>
      <Text style={textStyles.text}>{label}</Text>
      <Text style={textStyles.text}>
        {profiles?.find((profile) => profile.id === selected)?.name ??
          selected ??
          t("projectFactory.defaultModel")}
      </Text>
      <PresetControls
        serverId={target.serverId}
        profiles={picker}
        selectedProfileId={selected ?? undefined}
        disabled={pending}
      />
      <Button variant="secondary" disabled={pending || !selected} onPress={clear}>
        {t("projectFactory.defaultModel")}
      </Button>
      {target.role ? <Text style={textStyles.text}>{t("projectFactory.nextTurn")}</Text> : null}
      {error ? (
        <Text style={textStyles.text} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const textStyles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
