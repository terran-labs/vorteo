import { Text, View } from "react-native";
import { settingsStyles } from "@/styles/settings";
import { InstallationTypeRow } from "./installation-type-section";
import { OwnerSettingsGate } from "@/components/settings/owner-lock";
import { useToast } from "@/contexts/toast-context";
import { useCallback, useMemo, useState } from "react";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { toErrorMessage } from "@/utils/error-messages";
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

function UnlockedInstallationNameSection() {
  const name = useInstallationName();
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const save = useCallback(async () => {
    setSaving(true);
    try {
      const saved = await saveInstallationName(draft);
      setDraft(saved);
      toast.show("Saved.");
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }, [draft, toast]);
  const pressSave = useCallback(() => void save(), [save]);
  if (!readExecutionInstallation()) return null;
  const unchanged = draft.trim() === name || (!draft.trim() && name === DEFAULT_INSTALLATION_NAME);
  return (
    <SettingsSection title="Installation" testID="settings-installation-name">
      <SettingsCard testID="settings-about-installation">
        <SettingsRow
          label="Installation name"
          hint={`Shown in the browser tab, the welcome page and the sidebar. Leave empty for "${DEFAULT_INSTALLATION_NAME}".`}
        >
          <FormTextInput
            size="sm"
            initialValue={name}
            onChangeText={setDraft}
            onSubmitEditing={pressSave}
            placeholder={DEFAULT_INSTALLATION_NAME}
            maxLength={40}
            autoCorrect={false}
            editable={!saving}
            accessibilityLabel="Installation name"
            testID="settings-installation-name-input"
          />
          <Button
            variant="outline"
            size="sm"
            onPress={pressSave}
            disabled={saving || unchanged}
            testID="settings-installation-name-save"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </SettingsRow>
        <View style={settingsStyles.rowBorder}>
          <InstallationTypeRow />
        </View>
      </SettingsCard>
    </SettingsSection>
  );
}
