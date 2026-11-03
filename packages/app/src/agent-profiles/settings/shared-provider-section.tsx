import { reportSyncError } from "@/components/settings/sync-error-notification";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { useRouter } from "expo-router";
import { useSharedProviderProfiles } from "./use-shared-provider-profiles";
import { sharedChoiceState } from "../shared-choices";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, Pressable } from "react-native";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsCard, SettingsCollapsibleRow } from "@/components/settings";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { describeCopies, groupDuplicateProfiles, type ProfileGroup } from "./profile-duplicates";
import { settingsStyles } from "@/styles/settings";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { AgentProfileRow } from "./agent-profile-row";
import { toErrorMessage } from "@/utils/error-messages";

export function SharedProviderSection({
  serverId,
  provider,
}: {
  serverId: string;
  provider: string;
}) {
  const {
    shared,
    group,
    saveGroup,
    deleteWorkflow,
    installation,
    error: installationError,
  } = useSharedProviderProfiles(serverId, provider);
  const router = useRouter();
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const [operation, setOperation] = useState<{ status: "idle" } | { status: "saving" }>({
    status: "idle",
  });
  const toast = useToast();
  const failOperation = useCallback(
    (error: unknown) => {
      toast.show(toErrorMessage(error));
      setOperation({ status: "idle" });
    },
    [toast],
  );
  useEffect(() => {
    reportSyncError(
      `installation-profiles:${installation?.installationId ?? serverId}`,
      installationError,
      () => toast.show(toErrorMessage(installationError)),
    );
  }, [installationError, installation?.installationId, serverId, toast]);
  const openWorkflow = useCallback(
    (id = "new") => {
      if (!shared) return;
      // Profile editing leaves the provider sheet for a full page.
      useProviderSettingsStore.getState().close();
      router.push({
        pathname: "/settings/profiles/[profileId]",
        params: { profileId: id, providerType: provider, serverId },
      });
    },
    [shared, router, provider, serverId],
  );
  const openDefaults = useCallback(() => openWorkflow("defaults"), [openWorkflow]);
  const add = useCallback(() => openWorkflow("new"), [openWorkflow]);

  const changeDefault = useCallback(
    async (id: string) => {
      if (!shared || !group) return;
      setOperation({ status: "saving" });
      try {
        await saveGroup(shared, { ...group, defaultWorkflowId: id });
        setOperation({ status: "idle" });
      } catch (error) {
        failOperation(error);
      }
    },
    [shared, group, saveGroup, failOperation],
  );

  // Deleting a migrated workflow must retain its legacy launch and worker bindings.
  const remove = useCallback(
    async (id: string) => {
      if (!shared || !group) return;
      setOperation({ status: "saving" });
      try {
        await deleteWorkflow(id, shared);
        setOperation({ status: "idle" });
      } catch (error) {
        failOperation(error);
      }
    },
    [shared, group, deleteWorkflow, failOperation],
  );
  // Older copies are folded under their current profile, so moving a profile
  // swaps it with its visible neighbor rather than with a hidden copy.
  const reorder = useCallback(
    async (id: string, offset: number) => {
      if (!shared || !group) return;
      const visible = groupDuplicateProfiles(group.workflows).map((entry) => entry.primary.id);
      const position = visible.indexOf(id);
      const neighbor = visible[position + offset];
      if (position < 0 || !neighbor) return;
      const workflows = [...group.workflows];
      const from = workflows.findIndex((workflow) => workflow.id === id);
      const to = workflows.findIndex((workflow) => workflow.id === neighbor);
      [workflows[from], workflows[to]] = [workflows[to], workflows[from]];
      setOperation({ status: "saving" });
      try {
        await saveGroup(shared, { ...group, workflows });
        setOperation({ status: "idle" });
      } catch (error) {
        failOperation(error);
      }
    },
    [shared, group, saveGroup, failOperation],
  );
  const makeDefault = useCallback(
    (id: string) => {
      void changeDefault(id);
    },
    [changeDefault],
  );
  const moveUp = useCallback(
    (id: string) => {
      void reorder(id, -1);
    },
    [reorder],
  );
  const moveDown = useCallback(
    (id: string) => {
      void reorder(id, 1);
    },
    [reorder],
  );
  const workflows = useMemo(
    () =>
      (group?.workflows ?? []).map((workflow) =>
        Object.assign({}, group?.defaults, workflow, { provider }),
      ),
    [group, provider],
  );
  const pending = operation.status === "saving";
  const profileGroups = useMemo(() => groupDuplicateProfiles(workflows), [workflows]);

  const editDefaultsButton = useMemo(
    () => (
      <Button variant="ghost" size="sm" onPress={openDefaults} disabled={!shared || pending}>
        Edit defaults
      </Button>
    ),
    [openDefaults, shared, pending],
  );
  const addButton = useMemo(
    () => (
      <Button variant="ghost" size="sm" onPress={add} disabled={!shared || pending}>
        Add profile
      </Button>
    ),
    [add, shared, pending],
  );
  return (
    <>
      <SettingsSection
        title="Profiles"
        trailing={addButton}
        info="The starred profile is used when you pick this provider without choosing a profile."
        testID="shared-provider-profiles"
      >
        {profileGroups.length ? null : (
          <Text style={settingsStyles.rowHint}>
            No profiles yet. Add one to save a model setup.
          </Text>
        )}
        <View style={profileGroups.length ? settingsStyles.card : undefined}>
          {profileGroups.map((profileGroup, index) => (
            <ProfileGroupRows
              key={profileGroup.primary.id}
              group={profileGroup}
              entries={entries}
              provider={provider}
              isFirst={index === 0}
              isLast={index === profileGroups.length - 1}
              disabled={pending}
              defaultId={group?.defaultWorkflowId ?? null}
              onMakeDefault={makeDefault}
              onEdit={openWorkflow}
              onRemove={remove}
              onMoveUp={moveUp}
              onMoveDown={moveDown}
            />
          ))}
        </View>
      </SettingsSection>
      <SettingsSection
        title="Model defaults"
        trailing={editDefaultsButton}
        info={
          installation
            ? "Profiles belong to this installation and are available in every environment unless excluded. Account credentials and available models remain local."
            : undefined
        }
        testID="shared-provider-settings"
      >
        <SettingsCard>
          <Pressable
            accessibilityRole="button"
            onPress={openDefaults}
            disabled={!shared || pending}
            style={settingsStyles.row}
          >
            <Text style={settingsStyles.rowTitle}>Preferred models and reasoning</Text>
          </Pressable>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

interface ProfileGroupRowsProps {
  group: ProfileGroup<AgentProfile>;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  provider: string;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  defaultId: string | null;
  onMakeDefault: (id: string) => void;
}

function availabilityReason(
  profile: AgentProfile,
  entries: readonly ProviderSnapshotEntry[] | undefined,
  provider: string,
): string | null {
  const availability = sharedChoiceState({
    profile,
    choices: {},
    entry: entries?.find((entry) => entry.provider === provider),
  });
  return availability.modelError ?? availability.thinkingError ?? null;
}

/** A profile and, folded beneath it, any older copies that share its name. */
function ProfileGroupRows({
  group,
  entries,
  provider,
  isFirst,
  isLast,
  disabled,
  onEdit,
  onRemove,
  onMoveUp,
  onMoveDown,
  defaultId,
  onMakeDefault,
}: ProfileGroupRowsProps) {
  const { primary, copies } = group;
  return (
    <>
      <AgentProfileRow
        profile={primary}
        availabilityReason={availabilityReason(primary, entries, provider)}
        entries={entries}
        isFirst={isFirst}
        isLast={isLast && copies.length === 0}
        disabled={disabled}
        isDefault={primary.id === defaultId}
        onMakeDefault={onMakeDefault}
        onEdit={onEdit}
        onRemove={onRemove}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
      />
      {copies.length ? (
        <View style={settingsStyles.rowBorder} testID={`profile-copies-${primary.id}`}>
          <SettingsCollapsibleRow label={describeCopies(copies)}>
            {copies.map(({ profile }) => (
              <AgentProfileRow
                key={profile.id}
                profile={profile}
                availabilityReason={availabilityReason(profile, entries, provider)}
                entries={entries}
                isFirst
                isLast
                disabled={disabled}
                onEdit={onEdit}
                onRemove={onRemove}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
              />
            ))}
          </SettingsCollapsibleRow>
        </View>
      ) : null}
    </>
  );
}
