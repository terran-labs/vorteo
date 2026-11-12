import { reportSyncError } from "@/components/settings/sync-error-notification";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { useRouter } from "expo-router";
import { useSharedProviderProfiles } from "./use-shared-provider-profiles";
import { sharedChoiceState } from "../shared-choices";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsExpansionHeader } from "@/components/settings/settings-expansion";
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
  embedded = false,
}: {
  serverId: string;
  provider: string;
  /**
   * Render as divided rows inside the provider's expanded card, under in-card group headers,
   * rather than as separate sections with cards of their own.
   */
  embedded?: boolean;
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

  const [showingAll, setShowingAll] = useState(false);
  const showAll = useCallback(() => setShowingAll(true), []);
  const closeAll = useCallback(() => setShowingAll(false), []);
  const allHeader = useMemo(() => ({ title: "Profiles" }), []);
  const addButton = useMemo(
    () => (
      <Button
        variant="outline"
        onPress={add}
        disabled={!shared || pending}
        testID="shared-provider-add-profile"
      >
        Add profile
      </Button>
    ),
    [add, shared, pending],
  );
  const profilesInfo = installation
    ? "The starred profile is used when you pick this provider without choosing a profile. Profiles belong to this installation and work in every environment unless excluded. Credentials and available models stay with each environment."
    : "The starred profile is used when you pick this provider without choosing a profile.";
  // Editing from the full list closes it first, so the sheet never stays behind the editor.
  const editFromList = useCallback(
    (id: string) => {
      setShowingAll(false);
      openWorkflow(id);
    },
    [openWorkflow],
  );
  const renderGroups = (
    groups: readonly ProfileGroup<AgentProfile>[],
    bordered: boolean,
    onEdit: (id: string) => void = openWorkflow,
  ) =>
    groups.map((profileGroup, index) => (
      <View
        key={profileGroup.primary.id}
        style={bordered && index === 0 ? settingsStyles.rowBorder : undefined}
      >
        <ProfileGroupRows
          group={profileGroup}
          entries={entries}
          provider={provider}
          isFirst={profileGroups.indexOf(profileGroup) === 0}
          isLast={profileGroups.indexOf(profileGroup) === profileGroups.length - 1}
          disabled={pending}
          defaultId={group?.defaultWorkflowId ?? null}
          onMakeDefault={makeDefault}
          onEdit={onEdit}
          onRemove={remove}
          onMoveUp={moveUp}
          onMoveDown={moveDown}
        />
      </View>
    ));
  // A long list keeps the card short: the first few inline, the rest in a sheet.
  const overflow = profileGroups.length > PROFILE_PREVIEW_LIMIT;
  const inline = overflow ? profileGroups.slice(0, PROFILE_PREVIEW_LIMIT - 1) : profileGroups;
  const overflowRow = overflow ? (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <Text style={[settingsStyles.rowHint, styles.fill]}>
        {`${profileGroups.length - inline.length} more`}
      </Text>
      <Button
        {...OPENS_DIALOG}
        variant="outline"
        onPress={showAll}
        accessibilityLabel={`Show all ${profileGroups.length} profiles`}
        testID="shared-provider-all-profiles"
      >
        {`Show all ${profileGroups.length}`}
      </Button>
    </View>
  ) : null;
  const allSheet = showingAll ? (
    <AdaptiveModalSheet
      testID="shared-provider-all-profiles-sheet"
      visible
      onClose={closeAll}
      header={allHeader}
    >
      <View style={settingsStyles.card}>{renderGroups(profileGroups, false, editFromList)}</View>
    </AdaptiveModalSheet>
  ) : null;
  const emptyText = "No profiles yet. Add one to save a model setup.";
  // One row with one button: the row text is passive, and the outline button is the action.
  const defaultsRow = (bordered: boolean) => (
    <View style={[settingsStyles.row, bordered && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Model defaults</Text>
        <Text style={settingsStyles.rowHint}>Preferred models and reasoning</Text>
      </View>
      <Button
        variant="outline"
        onPress={openDefaults}
        disabled={!shared || pending}
        testID="shared-provider-edit-defaults"
      >
        Edit defaults
      </Button>
    </View>
  );

  if (embedded)
    return (
      <View testID="shared-provider-profiles">
        <SettingsExpansionHeader
          title="Profiles"
          info={profilesInfo}
          trailing={addButton}
          testID="shared-provider-profiles-header"
        />
        {profileGroups.length ? null : (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <Text style={[settingsStyles.rowHint, styles.fill]}>{emptyText}</Text>
          </View>
        )}
        {renderGroups(inline, true)}
        {overflowRow}
        <View testID="shared-provider-settings">{defaultsRow(true)}</View>
        {allSheet}
      </View>
    );

  return (
    <>
      <SettingsSection
        title="Profiles"
        trailing={addButton}
        info={profilesInfo}
        testID="shared-provider-profiles"
      >
        {profileGroups.length ? (
          <View style={settingsStyles.card}>
            {renderGroups(inline, false)}
            {overflowRow}
          </View>
        ) : (
          <Text style={settingsStyles.rowHint}>{emptyText}</Text>
        )}
      </SettingsSection>
      <SettingsSection title="Model defaults" testID="shared-provider-settings">
        <SettingsCard>{defaultsRow(false)}</SettingsCard>
      </SettingsSection>
      {allSheet}
    </>
  );
}

/** Tells screen readers on web that the button opens a dialog. */
const OPENS_DIALOG = isWeb ? ({ "aria-haspopup": "dialog" } as object) : {};

/** Up to this many profiles show inline; more open the full list in a sheet. */
const PROFILE_PREVIEW_LIMIT = 5;

const styles = StyleSheet.create({
  fill: { flex: 1, marginTop: 0 },
});

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
