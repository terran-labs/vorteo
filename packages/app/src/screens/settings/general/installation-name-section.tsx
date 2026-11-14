import { Text } from "react-native";
import { settingsStyles } from "@/styles/settings";
import { InstallationTypeRow } from "./installation-type-section";
import { TimeZoneRow } from "./time-zone-row";
import { OwnerSettingsGate } from "@/components/settings/owner-lock";
import { useMemo } from "react";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { AutoSaveField } from "@/components/settings/auto-save-field";
import { SettingsAdvancedGroup } from "@/components/settings/advanced-group";
import {
  DEFAULT_INSTALLATION_NAME,
  saveInstallationName,
  useInstallationName,
} from "@/execution-installation/installation-name";
import { readExecutionInstallation } from "@/execution-installation/policy";

/** Names this installation so two open side by side, such as a lab and production, never blur. */
export function InstallationNameSection() {
  const name = useInstallationName();
  const preview = useMemo(() => <Text style={settingsStyles.rowHint}>{name}</Text>, [name]);
  if (!readExecutionInstallation()) return null;
  return (
    <OwnerSettingsGate title={`Installation name: ${name}`} preview={preview}>
      <UnlockedInstallationNameSection />
    </OwnerSettingsGate>
  );
}

/** An empty name means the default, so clearing the field while it shows the default is no change. */
function nameChanged(draft: string, name: string) {
  const next = draft.trim();
  return next ? next !== name : name !== DEFAULT_INSTALLATION_NAME;
}

function UnlockedInstallationNameSection() {
  const name = useInstallationName();
  if (!readExecutionInstallation()) return null;
  return (
    <SettingsSection title="Installation" testID="settings-installation-name">
      <SettingsCard testID="settings-about-installation">
        <SettingsRow
          label="Installation name"
          hint={`Shown in the browser tab, the welcome page and the sidebar. Leave empty for "${DEFAULT_INSTALLATION_NAME}".`}
        >
          <AutoSaveField
            label="Installation name"
            value={name}
            onSave={saveInstallationName}
            isChanged={nameChanged}
            placeholder={DEFAULT_INSTALLATION_NAME}
            maxLength={40}
            autoCorrect={false}
            testID="settings-installation-name-input"
          />
        </SettingsRow>
        <TimeZoneRow />
      </SettingsCard>
      {/* Stable or Lab is chosen once, so it waits behind Advanced. */}
      <SettingsAdvancedGroup testID="settings-installation-advanced">
        <SettingsCard>
          <InstallationTypeRow />
        </SettingsCard>
      </SettingsAdvancedGroup>
    </SettingsSection>
  );
}
