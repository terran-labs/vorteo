import { useCallback, useMemo, useState, type ReactNode } from "react";
import { SettingsAdvancedGroup } from "@/components/settings/advanced-group";
import { Text, View, StyleSheet } from "react-native";
import { ScrollView } from "@/components/ui/scroll-view";
import { isWeb } from "@/constants/platform";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { AgentProfileSkillsRow } from "./agent-profile-skills-row";
import { AgentProfileAppearanceField } from "./agent-profile-appearance-field";
import type {
  AgentProfileFormModel,
  AgentProfileFormState,
  AgentProfileFormOption,
} from "../internal/profile-form-model";
import {
  useAgentProfileFormCatalog,
  useAgentProfileFormFeatures,
} from "../internal/use-profile-form-inputs";
import { useAgentProfiles } from "../internal/use-agent-profiles";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { resolveProviderType } from "@getpaseo/protocol/provider-preferences";
import { workerChoices, workerAccountProfiles } from "./worker-choices";
import { settingsStyles } from "@/styles/settings";

export interface ProfileSharedScope {
  providerType: string;
  kind: "defaults" | "workflow";
}
// React Native Web renders a header role without a level as h1. Form sections sit under the
// profile's own title, so they are level 3.
const SECTION_HEADING_LEVEL = isWeb ? ({ "aria-level": 3 } as object) : {};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text
        accessibilityRole="header"
        {...SECTION_HEADING_LEVEL}
        style={settingsStyles.sectionHeaderTitle}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}
const MAX_WORKER_OPTIONS = [
  ...Array.from({ length: 8 }, (_, index) => {
    const count = String(index + 1);
    return { id: count, value: count, label: count };
  }),
  { id: "uncapped", value: "uncapped", label: "No limit" },
];

function TextField({
  label,
  value,
  onChange,
  multiline = false,
  disabled,
  testID,
  hint,
  error,
}: {
  testID?: string;
  hint?: string;
  /** Why the field blocks Save; shown under it and tied to the input. */
  error?: string | null;
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  disabled: boolean;
}) {
  return (
    <Field label={label} testID={testID} hint={hint} error={error}>
      <FormTextInput
        initialValue={value}
        onChangeText={onChange}
        multiline={multiline}
        editable={!disabled}
        accessibilityLabel={label}
      />
    </Field>
  );
}
function ChoiceField({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
}: {
  hint?: string;
  label: string;
  value: string;
  options: AgentProfileFormOption[];
  onChange: (value: string, display: { label: string }) => void;
  disabled: boolean;
}) {
  const display = useMemo(
    () => ({ label: options.find((option) => option.value === value)?.label ?? value }),
    [options, value],
  );
  return (
    <SelectField
      label={label}
      hint={hint}
      testID={`agent-profile-${label.toLowerCase()}-field`}
      triggerTestID={`agent-profile-${label.toLowerCase()}-trigger`}
      value={value}
      selectedDisplay={display}
      options={options}
      onChange={onChange}
      placeholder="Choose"
      emptyText="No options available"
      disabled={disabled}
    />
  );
}
function FeatureField({
  feature,
  model,
  disabled,
}: {
  feature: AgentFeature;
  model: AgentProfileFormModel;
  disabled: boolean;
}) {
  const onChange = useCallback(
    (value: string | boolean) => model.setFeatureValue(feature.id, value),
    [model, feature.id],
  );
  const options = useMemo(
    () =>
      feature.type === "select"
        ? feature.options.map((option) => ({
            ...option,
            value: option.id,
            testID: `agent-profile-feature-option-${feature.id}-${option.id}`,
          }))
        : [],
    [feature],
  );
  const display = useMemo(
    () => ({
      label:
        feature.type === "select"
          ? (feature.options.find((option) => option.id === feature.value)?.label ??
            feature.value ??
            "Choose")
          : "",
    }),
    [feature],
  );
  if (feature.type === "select")
    return (
      <SelectField
        label={feature.label}
        value={feature.value}
        selectedDisplay={display}
        options={options}
        onChange={onChange}
        placeholder="Choose"
        emptyText="No options"
        disabled={disabled}
        testID={`agent-profile-feature-field-${feature.id}`}
        triggerTestID={`agent-profile-feature-trigger-${feature.id}`}
      />
    );
  return (
    <Field label={feature.label}>
      <Switch
        value={feature.value === true}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityLabel={feature.label}
      />
    </Field>
  );
}
function AvailabilityField({
  kind,
  state,
  model,
}: {
  kind: "host" | "container";
  state: AgentProfileFormState;
  model: AgentProfileFormModel;
}) {
  const label = kind === "host" ? "Host" : "Dev";
  const onChange = useCallback(
    (enabled: boolean) =>
      model.setExcludedEnvironments(
        enabled
          ? state.excludedEnvironments.filter((item) => item !== kind)
          : [...state.excludedEnvironments, kind],
      ),
    [kind, model, state.excludedEnvironments],
  );
  return (
    <Field label={label}>
      <Switch
        accessibilityLabel={label}
        value={!state.excludedEnvironments.includes(kind)}
        onValueChange={onChange}
        disabled={state.isSubmitting}
      />
    </Field>
  );
}
export function AgentProfileForm({
  serverId,
  profileId,
  model,
  state,
  sharedScope,
  modelDetails,
}: {
  serverId: string;
  profileId: string;
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
  sharedScope?: ProfileSharedScope;
  modelDetails?: (disabled: boolean) => ReactNode;
}) {
  useAgentProfileFormCatalog({ serverId, model, sharedScope });
  useAgentProfileFormFeatures({ serverId, model, state });
  const { profiles, legacyProfiles } = useAgentProfiles(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const { config } = useDaemonConfig(serverId);
  const [originalWorkerId] = useState(state.workerProfileId);
  const [workersEnabled, setWorkersEnabled] = useState(Boolean(state.workerProfileId));
  const workers = useMemo(
    () =>
      workerChoices({
        profiles: workerAccountProfiles(
          config,
          entries ?? [],
          profiles ?? [],
          legacyProfiles,
          state.workerProfileId,
        ),
        entries: entries ?? [],
        providers: config?.providers ?? {},
        supervisor: { id: profileId, provider: state.provider },
        selectedWorkerId: state.workerProfileId,
        originalWorkerId,
        accountId: state.workerAccountId,
      }),
    [
      config,
      entries,
      profiles,
      legacyProfiles,
      profileId,
      state.provider,
      state.workerProfileId,
      state.workerAccountId,
      originalWorkerId,
    ],
  );
  const toggleWorkers = useCallback(
    (enabled: boolean) => {
      setWorkersEnabled(enabled);
      if (!enabled) {
        model.setWorkerAccount("");
        model.setWorkerProfileId("");
      }
    },
    [model],
  );
  const changeLimit = useCallback(
    (value: string) => {
      if (value === "uncapped") {
        model.setMaxWorkers("uncapped");
        return;
      }
      const limit = Number(value);
      if (Number.isInteger(limit) && limit > 0) model.setMaxWorkers(limit);
    },
    [model],
  );
  // A saved limit above the usual choices stays selectable rather than showing as empty.
  const maxWorkerOptions = useMemo(() => {
    const current = String(state.maxWorkers);
    if (MAX_WORKER_OPTIONS.some((option) => option.value === current)) return MAX_WORKER_OPTIONS;
    return [{ id: current, value: current, label: current }, ...MAX_WORKER_OPTIONS];
  }, [state.maxWorkers]);
  const defaults = sharedScope?.kind === "defaults";
  const disabled = state.isSubmitting;
  const providerType = resolveProviderType(state.provider, config?.providers ?? {});
  return (
    <View>
      {!defaults ? (
        <Section title="Identity">
          {/* Save stays disabled until these hold, so each field says what is missing. */}
          <TextField
            label="Name"
            value={state.name}
            onChange={model.setName}
            disabled={disabled}
            error={state.name.trim() ? null : "Enter a name to save this profile"}
          />
          <AgentProfileAppearanceField
            label="Icon"
            icon={state.icon}
            color={state.color}
            onChange={model.setAppearance}
            disabled={disabled}
          />
          <TextField
            label="Nickname"
            value={state.nickname}
            onChange={model.setNickname}
            disabled={disabled}
          />
        </Section>
      ) : null}
      <Section title="Model">
        {sharedScope ? (
          <Text style={settingsStyles.rowHint}>
            Applies to all {sharedScope.providerType} accounts
          </Text>
        ) : (
          <ChoiceField
            label="Provider"
            value={state.provider}
            options={state.providerOptions}
            onChange={model.setProvider}
            disabled={disabled}
          />
        )}
        <ChoiceField
          label="Model"
          hint={state.compatibilityWarnings.join(" ")}
          value={state.modelId}
          options={state.modelOptions}
          onChange={model.setModel}
          disabled={disabled}
        />
        <ChoiceField
          label="Mode"
          value={state.modeId}
          options={state.modeOptions}
          onChange={model.setMode}
          disabled={disabled}
        />
        <ChoiceField
          label="Thinking"
          value={state.thinkingOptionId}
          options={state.thinkingOptions}
          onChange={model.setThinking}
          disabled={disabled}
        />
        <ScrollView style={styles.features} contentContainerStyle={styles.featureContent}>
          {state.features.map((feature) => (
            <FeatureField key={feature.id} feature={feature} model={model} disabled={disabled} />
          ))}
        </ScrollView>
      </Section>
      {modelDetails?.(disabled)}
      <Section title="Instructions">
        <TextField
          label="Launch instructions"
          value={state.instructions}
          onChange={model.setInstructions}
          multiline
          disabled={disabled}
        />
        {!defaults ? (
          <TextField
            label="When to use"
            testID="agent-profile-notes-field"
            hint="Helps agents choose this profile when starting another agent."
            value={state.notes}
            onChange={model.setNotes}
            multiline
            disabled={disabled}
          />
        ) : null}
      </Section>
      <Section title="Skills">
        <AgentProfileSkillsRow
          serverId={serverId}
          provider={providerType}
          value={state.skillPolicy}
          onChange={model.setSkillPolicy}
        />
      </Section>
      {!defaults ? (
        <Section title="Workers">
          <Switch
            accessibilityLabel="Enable workers"
            value={workersEnabled}
            onValueChange={toggleWorkers}
            disabled={disabled}
          />
          {workersEnabled ? (
            <>
              <SelectField
                label="Worker account"
                testID="agent-profile-worker-account-field"
                value={workers.accountId}
                selectedDisplay={workers.accountDisplay}
                options={workers.accountOptions}
                onChange={model.setWorkerAccount}
                placeholder="Choose account"
                emptyText="No eligible accounts"
                disabled={disabled}
              />
              <SelectField
                label="Worker profile"
                testID="agent-profile-worker-field"
                value={state.workerProfileId}
                selectedDisplay={workers.profileDisplay}
                options={workers.profiles}
                onChange={model.setWorkerProfileId}
                placeholder="Choose profile"
                emptyText="No eligible profiles"
                disabled={disabled}
                error={
                  workers.accountId && !state.workerProfileId
                    ? "Choose a worker profile to save"
                    : null
                }
              />
              {/* A fixed choice, so an invalid number can never be typed and silently ignored. */}
              <SelectField
                label="Maximum workers"
                testID="agent-profile-max-workers-field"
                value={String(state.maxWorkers)}
                selectedDisplay={
                  maxWorkerOptions.find((option) => option.value === String(state.maxWorkers)) ??
                  null
                }
                options={maxWorkerOptions}
                onChange={changeLimit}
                placeholder="Choose a limit"
                emptyText="No options"
                disabled={disabled}
              />
            </>
          ) : null}
        </Section>
      ) : null}
      {/* Profiles work in every environment; excluding one is rare, so it waits under Advanced. */}
      {!defaults ? (
        <SettingsAdvancedGroup testID="agent-profile-advanced">
          <Section title="Availability">
            <AvailabilityField kind="host" state={state} model={model} />
            <AvailabilityField kind="container" state={state} model={model} />
          </Section>
        </SettingsAdvancedGroup>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  section: { gap: 16, paddingVertical: 20 },
  features: { height: 180 },
  featureContent: { gap: 12 },
});
