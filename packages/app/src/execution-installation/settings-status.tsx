import { OwnerSettingsGate } from "@/components/settings/owner-lock";
import { useOwnerAccess } from "./owner-access";
import { reportSyncError } from "@/components/settings/sync-error-notification";
import { SettingsStatusLine } from "@/components/settings/settings-status-line";
import { useToast } from "@/contexts/toast-context";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  InstallationSettings,
  InstallationSettingsField,
} from "@getpaseo/protocol/installation-settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { isConnectionError, toErrorMessage } from "@/utils/error-messages";
import { useReportActionError } from "@/hooks/use-action-error";
import { useInstallationSettings } from "./settings";
import {
  conflictFieldLabel,
  defaultConflictChoices,
  describeConflictValue,
  duplicateSkills,
  fieldNeedsChoice,
  resolveConflicts,
  type ConflictChoices,
  type DuplicateSkill,
  type SettingsConflicts,
} from "./settings-conflicts";

const styles = StyleSheet.create((theme) => ({
  // Holds roughly a pane's first card so content arriving later grows downward, not jumps.
  reserved: { minHeight: 160 },
  choices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
}));

interface ChoiceOption {
  id: string;
  label: string;
}

function ChoiceButton({
  option,
  selected,
  onSelect,
  disabled,
  testID,
}: {
  option: ChoiceOption;
  selected: boolean;
  onSelect: (id: string) => void;
  disabled: boolean;
  testID: string;
}) {
  const press = useCallback(() => onSelect(option.id), [onSelect, option.id]);
  const state = useMemo(() => ({ selected }), [selected]);
  return (
    <Button
      variant={selected ? "default" : "outline"}
      onPress={press}
      disabled={disabled}
      accessibilityState={state}
      testID={testID}
    >
      {option.label}
    </Button>
  );
}

function ChoiceRow({
  options,
  selected,
  onSelect,
  disabled,
  testID,
}: {
  options: ChoiceOption[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  disabled: boolean;
  testID: string;
}) {
  return (
    <View style={styles.choices} testID={testID}>
      {options.map((option) => (
        <ChoiceButton
          key={option.id}
          option={option}
          selected={option.id === selected}
          onSelect={onSelect}
          disabled={disabled}
          testID={`${testID}-${option.id}`}
        />
      ))}
    </View>
  );
}

function FieldChoice({
  field,
  conflicts,
  labels,
  selected,
  onChoose,
  disabled,
}: {
  field: InstallationSettingsField;
  conflicts: SettingsConflicts;
  labels: Record<string, string>;
  selected: string | undefined;
  onChoose: (field: InstallationSettingsField, serverId: string) => void;
  disabled: boolean;
}) {
  const serverIds = Object.keys(conflicts.candidates);
  const options = useMemo(
    () =>
      Object.keys(conflicts.candidates).map((serverId) => ({
        id: serverId,
        label: `Use ${labels[serverId]}`,
      })),
    [conflicts, labels],
  );
  const select = useCallback((serverId: string) => onChoose(field, serverId), [onChoose, field]);
  return (
    <SettingsSection title={conflictFieldLabel(field)}>
      {serverIds.map((serverId) => (
        <Text key={serverId} style={settingsStyles.rowHint}>
          {labels[serverId]}: {describeConflictValue(field, conflicts.candidates[serverId])}
        </Text>
      ))}
      <ChoiceRow
        options={options}
        selected={selected}
        onSelect={select}
        disabled={disabled}
        testID={`settings-conflict-${field}`}
      />
    </SettingsSection>
  );
}

function SkillChoice({
  duplicate,
  selected,
  onChoose,
  disabled,
}: {
  duplicate: DuplicateSkill;
  selected: string | undefined;
  onChoose: (name: string, identity: string) => void;
  disabled: boolean;
}) {
  const options = useMemo(
    () =>
      duplicate.versions.map((version) => ({
        id: version.identity,
        label: `Version ${version.sha256.slice(0, 8)}`,
      })),
    [duplicate],
  );
  const select = useCallback(
    (identity: string) => onChoose(duplicate.name, identity),
    [onChoose, duplicate.name],
  );
  return (
    <SettingsSection title={`Skill: ${duplicate.name}`}>
      <Text style={settingsStyles.rowHint}>
        {duplicate.versions.length} different skills share this name. Keep one version.
      </Text>
      <ChoiceRow
        options={options}
        selected={selected}
        onSelect={select}
        disabled={disabled}
        testID={`settings-conflict-skill-${duplicate.name}`}
      />
    </SettingsSection>
  );
}

function ConflictResolver({
  conflicts,
  labels,
  hostServerId,
  onSave,
  saving,
}: {
  conflicts: SettingsConflicts;
  labels: Record<string, string>;
  hostServerId: string | undefined;
  onSave: (settings: Partial<InstallationSettings>) => Promise<void>;
  saving: boolean;
}) {
  const [choices, setChoices] = useState<ConflictChoices>(() =>
    defaultConflictChoices(conflicts, hostServerId),
  );
  const duplicates = useMemo(() => duplicateSkills(conflicts), [conflicts]);
  const resolved = useMemo(() => resolveConflicts(conflicts, choices), [conflicts, choices]);
  const chooseField = useCallback(
    (field: InstallationSettingsField, serverId: string) =>
      setChoices((current) => ({
        ...current,
        fields: { ...current.fields, [field]: serverId },
      })),
    [],
  );
  const chooseSkill = useCallback(
    (name: string, identity: string) =>
      setChoices((current) => ({
        ...current,
        skills: { ...current.skills, [name]: identity },
      })),
    [],
  );
  const save = useCallback(() => {
    if (resolved) void onSave(resolved);
  }, [onSave, resolved]);
  return (
    <View>
      {conflicts.fields
        .filter((field) => fieldNeedsChoice(field, conflicts))
        .map((field) => (
          <FieldChoice
            key={field}
            field={field}
            conflicts={conflicts}
            labels={labels}
            selected={choices.fields[field]}
            onChoose={chooseField}
            disabled={saving}
          />
        ))}
      {duplicates.map((duplicate) => (
        <SkillChoice
          key={duplicate.name}
          duplicate={duplicate}
          selected={choices.skills[duplicate.name]}
          onChoose={chooseSkill}
          disabled={saving}
        />
      ))}
      <Button
        variant="default"
        onPress={save}
        disabled={!resolved}
        loading={saving}
        testID="settings-conflict-save"
      >
        {saving ? "Saving..." : "Save shared settings"}
      </Button>
    </View>
  );
}

export function InstallationSettingsStatus(props: {
  children: ReactNode;
  showStatus?: boolean;
  title?: string;
}) {
  return (
    <OwnerSettingsGate title={props.title ?? "Installation settings"}>
      <UnlockedInstallationSettingsStatus {...props} />
    </OwnerSettingsGate>
  );
}

function UnlockedInstallationSettingsStatus({
  children,
  showStatus = false,
}: {
  children: ReactNode;
  showStatus?: boolean;
}) {
  const { installation, data, error, save } = useInstallationSettings();
  const toast = useToast();
  useEffect(() => {
    if (!data || !installation) return;
    reportSyncError(installation.installationId, error, () => toast.error(toErrorMessage(error)));
  }, [error, data, installation, toast]);
  const [saving, setSaving] = useState(false);
  const reportActionError = useReportActionError();
  const choose = useCallback(
    async (settings: Partial<InstallationSettings>) => {
      if (!data) return;
      setSaving(true);
      try {
        await save({ expectedRevision: data.revision, settings });
      } catch (cause) {
        if (isConnectionError(cause)) reportActionError(cause);
        else toast.error(toErrorMessage(cause));
      } finally {
        setSaving(false);
      }
    },
    [data, save, reportActionError, toast],
  );
  const environments = installation?.environments;
  const labels = useMemo(
    () =>
      Object.fromEntries(
        (environments ?? []).map((environment) => [
          environment.serverId,
          environment.kind === "host" ? "Host" : "Dev container",
        ]),
      ),
    [environments],
  );
  const hostServerId = environments?.find((environment) => environment.kind === "host")?.serverId;
  if (!installation) return children;
  if (error && !data)
    return (
      <View style={styles.reserved}>
        <SettingsStatusLine message={toErrorMessage(error)} />
      </View>
    );
  if (!data)
    return (
      <View style={styles.reserved} dataSet={loadingPane}>
        <SettingsStatusLine message="Loading shared settings..." />
      </View>
    );
  if (data.conflicts) {
    // The resolver lives once, in Environments; other panes say where to go instead of vanishing.
    if (!showStatus)
      return (
        <View style={styles.reserved}>
          <SettingsStatusLine message="Host and Dev disagree on shared settings. Choose values in Environments." />
        </View>
      );
    const conflicts = data.conflicts;
    return (
      <View>
        <Alert
          variant="warning"
          description="Host and Dev start with different settings. Choose which value each setting should share. Environment credentials remain local."
        />
        <ConflictResolver
          conflicts={conflicts}
          labels={labels}
          hostServerId={hostServerId}
          onSave={choose}
          saving={saving}
        />
      </View>
    );
  }
  if (!data.settings)
    return (
      <View style={styles.reserved} dataSet={loadingPane}>
        <SettingsStatusLine message="Reading shared settings..." />
      </View>
    );
  return (
    <>
      {showStatus ? <InstallationSettingsSyncStatus /> : null}
      {children}
    </>
  );
}

/** Place once in the page header, rather than once around each pane. */
export function InstallationSettingsSyncStatus() {
  const { status } = useOwnerAccess();
  if (status === "locked" || status === "checking") return null;
  return <UnlockedInstallationSettingsSyncStatus />;
}

function UnlockedInstallationSettingsSyncStatus() {
  const { data } = useInstallationSettings();
  const sources = Object.values(data?.sources ?? {});
  let message: string | null = null;
  if (sources.some((source) => source.pendingRevision !== null))
    message = "Syncing shared settings...";
  if (
    sources.some(
      (source) =>
        source.error &&
        [
          "read_failed",
          "patch_failed",
          "verification_failed",
          "plugin_projection_failed",
          "skill_projection_failed",
        ].includes(source.error),
    )
  )
    message = "Some environments haven't applied the latest shared settings yet.";
  if (sources.some((source) => source.error === "skill_removal_review_required"))
    message = "Open the skill selector and save again to review pending removals.";
  // Stuck account delivery outranks routine syncing: it will not finish on its own.
  if (sources.some((source) => source.error === "account_binding_unavailable"))
    message = "An account is not available in every environment yet. Check each connection.";
  return <SettingsStatusLine message={message} />;
}

const loadingPane = { settingsLoading: "true" };
