import { useCallback, useMemo } from "react";
import type {
  AgentProfile,
  ProviderPreferences,
  SharedProviderPreferences,
} from "@getpaseo/protocol/messages";
import { resolveProviderType } from "@getpaseo/protocol/provider-preferences";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useInstallationProfiles } from "@/execution-installation/profiles";
import { replaceProviderDefaults, editSharedProfile } from "./shared-profile-edits";
import type { AgentProfileValue } from "../internal/profile-form-model";

export function sharedProviderGroup(
  snapshot: SharedProviderPreferences,
  providerType: string,
): ProviderPreferences {
  return (
    snapshot.providers[providerType] ?? {
      defaults: {},
      preferredModels: [],
      preferredThinkingOptions: [],
      workflows: [],
      defaultWorkflowId: null,
    }
  );
}
/** Both Settings surfaces write the reviewed revision, never a refreshed revision. */
export function useSharedProviderProfiles(serverId: string, provider: string) {
  const { config, patchConfig } = useDaemonConfig(serverId);
  const {
    installation,
    data: sharedSnapshot,
    save: saveInstallation,
    error: installationError,
  } = useInstallationProfiles();
  const shared = useMemo(() => {
    const local = config?.sharedProviderPreferences;
    if (!installation) return local;
    if (!sharedSnapshot) return undefined;
    return {
      ...local,
      version: 1 as const,
      revision: sharedSnapshot.revision,
      providers: sharedSnapshot.providers,
      legacyProfiles: local?.legacyProfiles ?? {},
    };
  }, [config, installation, sharedSnapshot]);
  const providerType = resolveProviderType(provider, config?.providers ?? {});
  const group = shared?.providers[providerType];
  const saveGroup = useCallback(
    async (snapshot: SharedProviderPreferences, next: ProviderPreferences) => {
      if (installation) {
        await saveInstallation({
          expectedRevision: snapshot.revision,
          providers: { ...snapshot.providers, [providerType]: next },
        });
        return;
      }
      const saved = await patchConfig({
        expectedProviderPreferencesRevision: snapshot.revision,
        sharedProviderPreferences: {
          ...snapshot,
          providers: { ...snapshot.providers, [providerType]: next },
        },
      }).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "userMessage" in error &&
          typeof error.userMessage === "string"
        ) {
          throw new Error(error.userMessage.replace(/^Request failed: /, ""));
        }
        throw error;
      });
      if (!saved) throw new Error("Reconnect to the host before saving.");
    },
    [patchConfig, providerType, installation, saveInstallation],
  );

  const saveWorkflow = useCallback(
    async (profile: AgentProfile, snapshot: SharedProviderPreferences) => {
      const previous = sharedProviderGroup(snapshot, providerType);
      const workflow = editSharedProfile(
        previous,
        profile.id,
        providerType,
        profile,
        config?.providers ?? {},
        Boolean(installation),
      );
      const workflows = [...previous.workflows];
      const index = workflows.findIndex((item) => item.id === workflow.id);
      if (index < 0) workflows.push(workflow);
      else workflows[index] = workflow;
      await saveGroup(snapshot, {
        ...previous,
        workflows,
        defaultWorkflowId: previous.defaultWorkflowId ?? workflow.id,
      });
    },
    [providerType, config?.providers, installation, saveGroup],
  );
  const deleteWorkflow = useCallback(
    async (id: string, snapshot: SharedProviderPreferences) => {
      if (
        Object.values(snapshot.legacyProfiles).some(
          (binding) => binding.workflowId === id && binding.providerType === providerType,
        )
      ) {
        throw new Error(
          "Older launches and workers still use this profile. Keep it until they use another profile.",
        );
      }
      const previous = sharedProviderGroup(snapshot, providerType);
      const workflows = previous.workflows.filter((item) => item.id !== id);
      const defaultWorkflowId =
        previous.defaultWorkflowId === id ? (workflows[0]?.id ?? null) : previous.defaultWorkflowId;
      await saveGroup(snapshot, { ...previous, workflows, defaultWorkflowId });
    },
    [providerType, saveGroup],
  );
  const saveDefaults = useCallback(
    async (
      value: AgentProfileValue,
      snapshot: SharedProviderPreferences,
      preferred?: Pick<ProviderPreferences, "preferredModels" | "preferredThinkingOptions">,
    ) => {
      const {
        name: _name,
        provider: _provider,
        nickname: _nickname,
        icon: _icon,
        color: _color,
        notes: _notes,
        excludedEnvironments: _excluded,
        ...defaults
      } = value;
      await saveGroup(
        snapshot,
        Object.assign(
          replaceProviderDefaults(sharedProviderGroup(snapshot, providerType), defaults),
          preferred,
        ),
      );
    },
    [providerType, saveGroup],
  );
  return {
    shared,
    group,
    providerType,
    ready: Boolean(shared && config),
    saveWorkflow,
    deleteWorkflow,
    saveDefaults,
    saveGroup,
    installation,
    error: installationError,
  };
}
