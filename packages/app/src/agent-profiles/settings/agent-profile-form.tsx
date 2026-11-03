/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop -- These bounded form controls render with their draft; callbacks intentionally read the current draft. */
import { AgentProfileSkillsRow } from "./agent-profile-skills-row";
import { useState, type ReactNode } from "react";
import { Text, View, ScrollView } from "react-native";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { AgentProfileAppearanceField } from "./agent-profile-appearance-field";
import { Switch } from "@/components/ui/switch";
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
import { workerChoices, workerAccountProfiles } from "./worker-choices";
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 16, paddingVertical: 20 }}>
      <Text accessibilityRole="header">{title}</Text>
      {children}
    </View>
  );
}
export function AgentProfileForm({
  serverId,
  profileId,
  model,
  state,
}: {
  serverId: string;
  profileId: string;
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
}) {
  useAgentProfileFormCatalog({ serverId, model, sharedScope: undefined });
  useAgentProfileFormFeatures({ serverId, model, state });
  const { profiles, legacyProfiles } = useAgentProfiles(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const { config } = useDaemonConfig(serverId);
  const [workersEnabled, setWorkersEnabled] = useState(Boolean(state.workerProfileId));
  const workers = workerChoices({
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
    originalWorkerId: state.workerProfileId,
    accountId: state.workerAccountId,
  });
  const text = (
    label: string,
    value: string,
    change: (value: string) => void,
    multiline = false,
  ) => (
    <Field label={label}>
      <FormTextInput
        initialValue={value}
        onChangeText={change}
        multiline={multiline}
        editable={!state.isSubmitting}
        accessibilityLabel={label}
      />
    </Field>
  );
  const select = (
    label: string,
    value: string,
    options: AgentProfileFormOption[],
    change: (value: string, display: { label: string }) => void,
  ) => (
    <SelectField
      label={label}
      value={value}
      selectedDisplay={{
        label: options.find((option) => option.value === value)?.label ?? value,
      }}
      options={options}
      onChange={change}
      placeholder="Choose"
      emptyText="No options available"
      disabled={state.isSubmitting}
    />
  );
  return (
    <View>
      <Section title="Identity">
        {text("Name", state.name, model.setName)}
        <AgentProfileAppearanceField
          label="Icon"
          icon={state.icon}
          color={state.color}
          onChange={model.setAppearance}
          disabled={state.isSubmitting}
        />
        {text("Nickname", state.nickname, model.setNickname)}
      </Section>
      <Section title="Model">
        {select("Provider", state.provider, state.providerOptions, model.setProvider)}
        {select("Model", state.modelId, state.modelOptions, model.setModel)}
        {select("Mode", state.modeId, state.modeOptions, model.setMode)}
        {select("Thinking", state.thinkingOptionId, state.thinkingOptions, model.setThinking)}
        <ScrollView style={{ height: 180 }} contentContainerStyle={{ gap: 12 }}>
          {state.features.map((feature) =>
            feature.type === "select" ? (
              <SelectField
                key={feature.id}
                label={feature.label}
                value={feature.value}
                selectedDisplay={{ label: feature.value ?? "Choose" }}
                options={feature.options.map((option) => ({
                  ...option,
                  value: option.id,
                }))}
                onChange={(value) => model.setFeatureValue(feature.id, value)}
                placeholder="Choose"
                emptyText="No options"
              />
            ) : (
              <Field key={feature.id} label={feature.label}>
                <Switch
                  value={feature.value === true}
                  onValueChange={(value) => model.setFeatureValue(feature.id, value)}
                />
              </Field>
            ),
          )}
        </ScrollView>
      </Section>
      <Section title="Instructions">
        {text("Launch instructions", state.instructions, model.setInstructions, true)}
        {text("When to use", state.notes, model.setNotes, true)}
      </Section>
      <Section title="Skills">
        <AgentProfileSkillsRow
          serverId={serverId}
          provider={state.provider}
          value={state.skillPolicy}
          onChange={model.setSkillPolicy}
        />
      </Section>
      <Section title="Workers">
        <Switch
          accessibilityLabel="Enable workers"
          value={workersEnabled}
          onValueChange={(enabled) => {
            setWorkersEnabled(enabled);
            if (!enabled) {
              model.setWorkerAccount("");
              model.setWorkerProfileId("");
            }
          }}
        />
        {workersEnabled ? (
          <>
            <SelectField
              label="Worker account"
              value={workers.accountId}
              selectedDisplay={workers.accountDisplay}
              options={workers.accountOptions}
              onChange={model.setWorkerAccount}
              placeholder="Choose account"
              emptyText="No eligible accounts"
            />
            <SelectField
              label="Worker profile"
              value={state.workerProfileId}
              selectedDisplay={workers.profileDisplay}
              options={workers.profiles}
              onChange={model.setWorkerProfileId}
              placeholder="Choose profile"
              emptyText="No eligible profiles"
            />
            {text("Maximum workers", String(state.maxWorkers), (value) => {
              const limit = Number(value);
              if (Number.isInteger(limit) && limit > 0) model.setMaxWorkers(limit);
            })}
          </>
        ) : null}
      </Section>
      <Section title="Availability">
        {(["host", "container"] as const).map((kind) => (
          <Field key={kind} label={kind === "host" ? "Host" : "Dev"}>
            <Switch
              accessibilityLabel={kind === "host" ? "Host" : "Dev"}
              value={!state.excludedEnvironments.includes(kind)}
              onValueChange={(enabled) =>
                model.setExcludedEnvironments(
                  enabled
                    ? state.excludedEnvironments.filter((item) => item !== kind)
                    : [...state.excludedEnvironments, kind],
                )
              }
            />
          </Field>
        ))}
      </Section>
    </View>
  );
}
