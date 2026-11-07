import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { settingsStyles } from "@/styles/settings";
import type { AgentProfile, SharedProviderPreferences } from "@getpaseo/protocol/messages";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AgentProfilePage } from "@/agent-profiles/settings/agent-profile-page";
import type { AgentProfileValue } from "@/agent-profiles/internal/profile-form-model";
import { generateAgentProfileId } from "@/agent-profiles/internal/profile-id";
import { parseProfileRoute } from "@/agent-profiles/settings/agent-profile-page-model";
import {
  sharedProviderGroup,
  useSharedProviderProfiles,
} from "@/agent-profiles/settings/use-shared-provider-profiles";

import { PreferredChoicesField } from "@/agent-profiles/settings/preferred-choices-field";
import { sharedChoiceState } from "@/agent-profiles/shared-choices";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { resolveProviderType } from "@getpaseo/protocol/provider-preferences";

interface RouteEditorProps {
  serverId: string;
  provider: string;
  profileId: string;
  shared: SharedProviderPreferences;
}
/** Capture the reviewed revision once; polls must never silently authorize a newer revision. */
function RouteEditor({ serverId, provider, profileId, shared }: RouteEditorProps) {
  const [snapshot] = useState(shared);
  const { providerType, saveWorkflow, deleteWorkflow, saveDefaults } = useSharedProviderProfiles(
    serverId,
    provider,
  );
  const router = useRouter();
  const originalGroup = sharedProviderGroup(snapshot, providerType);
  const [preferredModels, setPreferredModels] = useState(originalGroup.preferredModels);
  const [preferredThinkingOptions, setPreferredThinkingOptions] = useState(
    originalGroup.preferredThinkingOptions,
  );
  const toggleModel = useCallback(
    (id: string) =>
      setPreferredModels((values) =>
        values.includes(id) ? values.filter((value) => value !== id) : [...values, id],
      ),
    [],
  );
  const toggleThinking = useCallback(
    (id: string) =>
      setPreferredThinkingOptions((values) =>
        values.includes(id) ? values.filter((value) => value !== id) : [...values, id],
      ),
    [],
  );
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const { config } = useDaemonConfig(serverId);
  const choices = useMemo(
    () =>
      sharedChoiceState({
        profile: { ...originalGroup.defaults, id: "defaults", name: "Defaults", provider },
        choices: {},
        entry: entries?.find((entry) => entry.provider === provider),
        family: (entries ?? []).filter(
          (entry) => resolveProviderType(entry.provider, config?.providers ?? {}) === providerType,
        ),
        preferences: originalGroup,
      }),
    [originalGroup, provider, providerType, entries, config],
  );
  const thinkingOptions = useMemo(
    () => choices.thinkingOptions.filter((option) => option.value !== ""),
    [choices],
  );

  const defaults = profileId === "defaults";
  const [profile] = useState<AgentProfile | null>(() => {
    const group = sharedProviderGroup(snapshot, providerType);
    if (defaults)
      return { ...group.defaults, id: "provider-defaults", name: "Provider defaults", provider };
    const workflow =
      profileId === "new"
        ? {
            id: generateAgentProfileId(),
            name: "",
            provider: providerType,
            workerProfileId: "",
            maxWorkers: 2,
          }
        : group.workflows.find((item) => item.id === profileId);
    return workflow ? { ...group.defaults, ...workflow, provider } : null;
  });
  const scope = useMemo(
    () => ({ providerType, kind: defaults ? ("defaults" as const) : ("workflow" as const) }),
    [providerType, defaults],
  );
  const back = useCallback(
    () =>
      router.replace({
        pathname: "/settings/accounts/[providerType]",
        params: { providerType, serverId },
      }),
    [router, providerType, serverId],
  );
  const save = useCallback(
    async (value: AgentProfileValue) => {
      if (!profile) throw new Error("Profile unavailable");
      if (defaults)
        await saveDefaults(value, snapshot, { preferredModels, preferredThinkingOptions });
      else await saveWorkflow({ ...value, id: profile.id }, snapshot);
    },
    [
      profile,
      defaults,
      saveDefaults,
      saveWorkflow,
      snapshot,
      preferredModels,
      preferredThinkingOptions,
    ],
  );
  const remove = useCallback(async () => {
    if (!profile) throw new Error("Profile unavailable");
    await deleteWorkflow(profile.id, snapshot);
  }, [profile, deleteWorkflow, snapshot]);
  const modelDetails = useCallback(
    (disabled: boolean) =>
      defaults ? (
        <>
          <PreferredChoicesField
            label="Preferred models"
            options={choices.modelOptions}
            preferred={preferredModels}
            onToggle={toggleModel}
            disabled={disabled}
          />
          <PreferredChoicesField
            label="Preferred reasoning"
            options={thinkingOptions}
            preferred={preferredThinkingOptions}
            onToggle={toggleThinking}
            disabled={disabled}
          />
        </>
      ) : null,
    [
      defaults,
      choices.modelOptions,
      preferredModels,
      toggleModel,
      thinkingOptions,
      preferredThinkingOptions,
      toggleThinking,
    ],
  );
  if (!profile) return <Text style={settingsStyles.rowHint}>Profile unavailable</Text>;
  return (
    <AgentProfilePage
      serverId={serverId}
      profile={profile}
      mode={profileId === "new" ? "create" : "edit"}
      sharedScope={scope}
      additionalDirty={
        defaults &&
        (JSON.stringify(preferredModels) !== JSON.stringify(originalGroup.preferredModels) ||
          JSON.stringify(preferredThinkingOptions) !==
            JSON.stringify(originalGroup.preferredThinkingOptions))
      }
      modelDetails={modelDetails}
      onBack={back}
      onSave={save}
      onDelete={defaults || profileId === "new" ? undefined : remove}
    />
  );
}
function ProfileRouteBody() {
  const { serverId, providerType, profileId } = parseProfileRoute(useLocalSearchParams());
  const { shared, ready, error } = useSharedProviderProfiles(serverId ?? "", providerType ?? "");
  if (!serverId || !providerType || !profileId)
    return <Text style={settingsStyles.rowHint}>Profile address is incomplete</Text>;
  if (!shared || !ready)
    return (
      <Text style={settingsStyles.rowHint}>
        {error instanceof Error ? error.message : "Loading profiles…"}
      </Text>
    );
  return (
    <RouteEditor
      key={`${serverId}:${providerType}:${profileId}`}
      serverId={serverId}
      provider={providerType}
      profileId={profileId}
      shared={shared}
    />
  );
}
export default function ProfileRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ProfileRouteBody />
    </HostRouteBootstrapBoundary>
  );
}
