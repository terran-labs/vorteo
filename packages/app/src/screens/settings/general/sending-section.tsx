import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSelect } from "@/components/settings";
import { useAppSettings, type SendShortcut } from "@/hooks/use-settings";
import { useHardwareKeyboardPresent, supportsConfigurableComposerSendKeys } from "@/keyboard";
import { getShortcutOs } from "@/utils/shortcut-platform";

export function SendingSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const shortcutsAvailable = useHardwareKeyboardPresent() && supportsConfigurableComposerSendKeys;
  const modifier = getShortcutOs() === "mac" ? "⌘" : "Ctrl";
  const shortcutOptions = useMemo(
    () =>
      (["enter", "mod-enter"] as const).map((value) => ({
        value,
        label: t(`settings.general.sendShortcut.options.${value}`, { modifier }),
      })),
    [t, modifier],
  );
  const changeSendShortcut = useCallback(
    (sendShortcut: SendShortcut) => void updateSettings({ sendShortcut }),
    [updateSettings],
  );
  if (!shortcutsAvailable) return null;
  return (
    <SettingsSection title={t("settings.general.sending")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.general.sendShortcut.label")}
          value={settings.sendShortcut}
          options={shortcutOptions}
          onValueChange={changeSendShortcut}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
