import { View } from "react-native";
import {
  SettingsCard,
  SettingsCollapsibleRow,
  SettingsRow,
  SettingsSwitch,
} from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
import { useUsageDisplay, type UsageDisplay } from "./display";
import { useUsageSetting } from "./setting";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";

import type { UsageDisplayAs } from "./preferences";

export function UsageOptions({
  display: providedDisplay,
  serverId = null,
}: {
  display?: UsageDisplay;
  serverId?: string | null;
}) {
  const { display: defaultDisplay } = useUsageDisplay();
  const display = providedDisplay ?? defaultDisplay;
  const setting = useUsageSetting(serverId);
  const { t } = useTranslation();
  // Rendered labels follow the app language; usageCopy holds English text for non-UI messages.
  const displayAsOptions: SegmentedControlOption<UsageDisplayAs>[] = [
    { value: "used", label: t("providerUsage.displayUsed"), testID: "usage-display-used" },
    {
      value: "remaining",
      label: t("providerUsage.displayRemaining"),
      testID: "usage-display-remaining",
    },
  ];
  return (
    <View style={settingsStyles.section}>
      <SettingsCard>
        <SettingsCollapsibleRow label={t("providerUsage.options")} testID="usage-options">
          {setting.error ? <Alert variant="error" description={setting.error.message} /> : null}
          {setting.supported ? (
            <SettingsSwitch
              label={t("providerUsage.checkUsage")}
              disabled={!setting.ready}
              value={setting.enabled}
              onValueChange={setting.setEnabled}
            />
          ) : null}
          <SettingsRow label={t("providerUsage.displayAs")}>
            <SegmentedControl
              options={displayAsOptions}
              value={display.displayAs}
              onValueChange={display.setDisplayAs}
              size="sm"
              testID="usage-display-as"
            />
          </SettingsRow>
        </SettingsCollapsibleRow>
      </SettingsCard>
    </View>
  );
}
